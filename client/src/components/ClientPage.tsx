import ChatControls from "@/components/ChatControls";
import ChatMessages from "@/components/ChatMessages";
import DeleteConversationModal from "@/components/DeleteConversationModal";
import Settings from "@/components/Settings";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { VoiceIndicator } from "@/components/VoiceIndicator";
import { WebSocketVoiceChat } from "@/components/WebSocketVoiceChat";
import { useAppState } from "@/hooks/useAppState";
import { useConversation } from "@/hooks/useConversation";
import emitter from "@/lib/eventEmitter";
import { RTVIClient } from "@pipecat-ai/client-js";
import { RTVIClientAudio, RTVIClientProvider } from "@pipecat-ai/client-react";
import { DailyTransport } from "@pipecat-ai/daily-transport";
import { GeminiLiveWebsocketTransport } from "@pipecat-ai/gemini-live-websocket-transport";
import {
  ArrowDownIcon,
  AudioWaveformIcon,
  DatabaseIcon,
  LoaderCircleIcon,
  XCircleIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useState } from "react";
import PipecatLogo from "./svg/Pipecat";

const defaultRequestData = {
  bot_profile: "vision",
};

export function ClientPage() {
  const {
    conversationId,
    conversationType,
    setConversationType,
    geminiApiKey,
    webrtcEnabled,
    websocketEnabled,
  } = useAppState();

  const { conversation, isFetching } = useConversation(conversationId);
  const messages = conversation?.messages ?? [];
  const visibleMessages = messages.filter((m) => m.content.role !== "system");

  const [showMessage, setShowMessages] = useState(false);
  useEffect(() => {
    const handleShowChatMessages = () => setShowMessages(true);
    emitter.on("showChatMessages", handleShowChatMessages);
    return () => {
      emitter.off("showChatMessages", handleShowChatMessages);
    };
  }, []);

  const [client, setClient] = useState<RTVIClient>();

  useEffect(() => {
    if (!conversationType) {
      setShowMessages(false);
    }
  }, [conversationType]);

  useEffect(() => {
    if (!conversationType) {
      setClient((prevClient) => {
        if (prevClient?.connected) prevClient?.disconnect();
        return undefined;
      });
      return;
    }

    const newClient = new RTVIClient({
      enableCam: false,
      enableMic: conversationType === "voice-to-voice",
      transport:
        conversationType === "voice-to-voice"
          ? new GeminiLiveWebsocketTransport({
              api_key: geminiApiKey,
            })
          : new DailyTransport(),
      params: {
        baseUrl:
          conversationType === "voice-to-voice"
            ? null
            : (import.meta.env.VITE_SERVER_URL as string),
        endpoints: {
          connect:
            conversationType === "voice-to-voice" ? null : "/bot/connect",
          action: "/bot/action",
        },
        requestData: {
          bot_profile:
            conversationType === "text-voice" ? "vision" : "voice-to-voice",
          conversation_id: "",
        },
      },
    });

    setClient(newClient);
  }, [conversationType, geminiApiKey]);

  useEffect(() => {
    if (!client || !conversationId) return;
    client.params.requestData = {
      ...defaultRequestData,
      ...(client.params.requestData ?? {}),
      conversation_id: conversationId,
    };
  }, [client, conversationId]);

  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  useLayoutEffect(() => {
    const handleScroll = () => {
      const scroller = document.scrollingElement;
      if (!scroller) return;
      const scrollBottom =
        scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
      setShowScrollToBottom(
        scroller.scrollHeight > scroller.clientHeight && scrollBottom > 150,
      );
    };
    window.addEventListener("scroll", handleScroll);
    return () => {
      window.removeEventListener("scroll", handleScroll);
    };
  }, []);

  useEffect(() => {
    if (!client) return;
    const handleChangeLlmModel = (model: string) => {
      if (client.connected) {
        client.updateConfig([
          {
            service: "llm",
            options: [
              {
                name: "model",
                value: model,
              },
            ],
          },
        ]);
      } else {
        const config = client.params.config;
        if (config) {
          const llmConfig = config.find((c) => c.service === "llm");
          client.params.config = [
            ...config,
            {
              service: "llm",
              options: [
                ...(llmConfig?.options ?? []),
                {
                  name: "model",
                  value: model,
                },
              ],
            },
          ];
        } else {
          client.params.config = [
            {
              service: "llm",
              options: [
                {
                  name: "model",
                  value: model,
                },
              ],
            },
          ];
        }
      }
    };
    emitter.on("changeLlmModel", handleChangeLlmModel);
    return () => {
      emitter.off("changeLlmModel", handleChangeLlmModel);
    };
  }, [client]);

  useEffect(() => {
    if (!client) return;
    const isConnected = client.connected;
    const isConnecting =
      client.state === "authenticating" || client.state === "connecting";
    if (isConnecting || isConnected) {
      client.disconnect();
    }
  }, [client, conversationId]);

  return (
    <RTVIClientProvider client={client!}>
      <div className="flex-grow grid grid-cols-1 grid-rows-[1fr_min-content]">
        {/* Messages */}
        <div className="relative flex-grow p-4 pb-8 flex flex-col">
          {conversationType === "voice-to-voice" ? (
            <WebSocketVoiceChat />
          ) : isFetching ? (
            <div className="flex-grow flex items-center justify-center">
              <LoaderCircleIcon className="animate-spin" />
            </div>
          ) : visibleMessages.length > 0 || showMessage ? (
            <ChatMessages
              autoscroll={!showScrollToBottom}
              messages={messages}
            />
          ) : conversationType === "text-voice" ? (
            <div className="flex flex-col gap-4 items-center justify-center h-full my-auto">
              <VoiceIndicator className="shadow-md" size={72} />
              <h2 className="font-semibold text-xl text-center">
                Start chatting
              </h2>
            </div>
          ) : (
            <div className="flex flex-col gap-12 items-center justify-center h-full my-auto">
              <h2 className="font-light text-2xl text-center text-neutral-700">
                Select conversation type:
              </h2>
              <div className="grid md:grid-cols-2 gap-8 lg:gap-12 items-center justify-center">
                <Button
                  disabled={!websocketEnabled}
                  variant="secondary-outline"
                  className="relative h-full flex flex-col border border-transparent bg-origin-border borderClip bg-cardBorder justify-between gap-2 max-w-72 lg:max-w-80 text-wrap rounded-3xl p-4 lg:p-6 shadow-mid hover:shadow-long hover:bg-cardBorderHover transition-all text-base outline outline-neutral-400/10 outline-0 hover:outline-[7px]"
                  onClick={() => setConversationType("voice-to-voice")}
                >
                  {!websocketEnabled && (
                    <div className="bg-red-200 self-stretch absolute -top-4 left-10 right-10 z-10 rounded-full text-xs py-2 uppercase tracking-wider text-red-900">
                      Missing GEMINI_API_KEY
                    </div>
                  )}
                  <div className="flex items-center justify-center bg-sky-100 text-sky-400 rounded-full">
                    <AudioWaveformIcon className="h-20 w-20 p-4" />
                  </div>
                  <div className="flex flex-col gap-2">
                    <strong className="block mt-4 text-lg">
                      WebSocket Voice-to-Voice
                    </strong>
                    <span className="font-light text-neutral-500">
                      Use your mic to talk with Gemini using a WebSocket.
                    </span>
                  </div>
                  <span className="opacity-50 inline-flex gap-1 items-center mt-4">
                    <XCircleIcon className="text-destructive" size={16} />
                    <span className="uppercase font-light text-neutral-700 text-xs tracking-wider">
                      Conversations not stored
                    </span>
                  </span>
                </Button>
                <Button
                  disabled={!webrtcEnabled}
                  variant="secondary-outline"
                  className="relative h-full flex flex-col items-center border border-transparent bg-origin-border borderClip bg-cardBorder justify-between gap-2 max-w-72 lg:max-w-80 text-wrap rounded-3xl p-4 lg:p-6 shadow-mid hover:shadow-long hover:bg-cardBorderHover transition-all text-base outline outline-neutral-400/10 outline-0 hover:outline-[7px]"
                  onClick={() => setConversationType("text-voice")}
                >
                  {!webrtcEnabled && (
                    <div className="bg-red-200 self-stretch absolute -top-4 left-10 right-10 z-10 rounded-full text-xs py-2 uppercase tracking-wider text-red-900">
                      Missing DAILY_API_KEY
                    </div>
                  )}
                  <div className="flex items-center justify-center bg-orange-100 text-orange-400 rounded-full">
                    <PipecatLogo className="h-20 w-20 p-4" />
                  </div>
                  <div className="flex flex-col gap-2">
                    <strong className="block mt-4 text-lg">
                      Pipecat Multi-Modal
                    </strong>
                    <span className="font-light text-neutral-500">
                      Use your mic, camera and keyboard to talk with Gemini
                      using WebRTC.
                    </span>
                  </div>
                  <span className="opacity-50 inline-flex gap-1 items-center mt-4">
                    <DatabaseIcon className="text-green-400" size={16} />
                    <span className="uppercase font-light text-neutral-700 text-xs tracking-wider">
                      Conversations stored
                    </span>
                  </span>
                </Button>
              </div>
            </div>
          )}
          {showScrollToBottom && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    className="rounded-full fixed right-4 bottom-20 z-20"
                    onClick={() =>
                      document.scrollingElement?.scrollTo({
                        behavior: "smooth",
                        top: document.scrollingElement?.scrollHeight,
                      })
                    }
                    size="icon"
                    variant="outline"
                  >
                    <ArrowDownIcon size={16} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent
                  align="center"
                  className="bg-popover text-popover-foreground"
                  side="left"
                >
                  Scroll to bottom
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>

        {/* Chat controls */}
        {conversationType === "text-voice" && (
          <div className="flex-none bg-background sticky bottom-0 w-full z-10">
            <ChatControls vision />
            {/* Prevents scroll content from showing up below chat controls */}
            <div className="h-4 bg-background w-full" />
          </div>
        )}
      </div>

      <RTVIClientAudio />
      <Settings vision={conversationType === "text-voice"} />
      <DeleteConversationModal />
    </RTVIClientProvider>
  );
}
