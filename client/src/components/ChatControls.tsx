import BotReadyAudio from "@/components/BotReadyAudio";
import ExpiryCountdown from "@/components/ExpiryCountdown";
import { Button } from "@/components/ui/button";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from "@/components/ui/carousel";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { toast } from "@/hooks/use-toast";
import { useAppState } from "@/hooks/useAppState";
import emitter from "@/lib/eventEmitter";
import { ImageContent, Message } from "@/lib/messages";
import { cn } from "@/lib/utils";
import { RTVIClient, RTVIEvent, RTVIMessage } from "@pipecat-ai/client-js";
import {
  RTVIClientVideo,
  useRTVIClient,
  useRTVIClientEvent,
  useRTVIClientMediaTrack,
  useRTVIClientTransportState,
  VoiceVisualizer,
} from "@pipecat-ai/client-react";
import {
  AlertCircleIcon,
  ArrowLeftToLineIcon,
  ArrowRightToLineIcon,
  ArrowUpIcon,
  LoaderCircle,
  LoaderCircleIcon,
  Maximize2Icon,
  MicIcon,
  MicOffIcon,
  Minimize2Icon,
  PaperclipIcon,
  ScreenShareIcon,
  Speech,
  TriangleAlertIcon,
  UploadCloudIcon,
  WebcamIcon,
  X,
  XIcon,
} from "lucide-react";
import {
  FormEvent,
  KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

const MAX_TOTAL_FILE_SIZE = 20.0 * 1e6; // 20 MB

function getHumanReadableFilesize(size: number) {
  if (size < 1e3) {
    return `${size} bytes`;
  } else if (size >= 1e3 && size < 1e6) {
    return `${(size / 1e3).toFixed(1)} KB`;
  } else {
    return `${(size / 1e6).toFixed(1)} MB`;
  }
}

interface Props {
  onChangeMode?: (isVoiceMode: boolean) => void;
  vision?: boolean;
}

type VideoSize = "small" | "large";
type VideoPlacement = "left" | "right";

type UploadStatus = "done" | "error";

const ChatControls: React.FC<Props> = ({ onChangeMode, vision = false }) => {
  const { conversationId, setConversationId, webrtcEnabled } = useAppState();

  const [isVoiceMode, setIsVoiceMode] = useState(false);
  const [isCamMuted, setIsCamMuted] = useState(true);
  const [isScreenMuted, setIsScreenMuted] = useState(true);
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [videoSize, setVideoSize] = useState<VideoSize>("small");
  const [videoPlacement, setVideoPlacement] = useState<VideoPlacement>("right");
  const [, setSelectedImages] = useState<File[]>([]); // Track selected image files
  const [previewUrls, setPreviewUrls] = useState<string[]>([]); // Track preview URLs
  const [imageZoom, setImageZoom] = useState(false);
  const [startIndex, setStartIndex] = useState(0);
  const [attachmentIds, setAttachmentIds] = useState<string[]>([]);

  const [text, setText] = useState("");

  const rtviClient = useRTVIClient();
  const transportState = useRTVIClientTransportState();

  const [endDate, setEndDate] = useState<Date | null>(null);
  const [error, setError] = useState("");
  const [processingAction, setProcessingAction] = useState(false);

  const [uploadProgress, setUploadProgress] = useState<
    Record<string, number | UploadStatus>
  >({});

  const xhrsRef = useRef<Record<string, XMLHttpRequest>>({});

  // const { toast } = useToast();

  const formRef = useRef<HTMLFormElement>(null);

  const handleTextKeyDown = (ev: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!formRef.current) return;
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      formRef.current.requestSubmit();
    }
  };

  const newConversationIdRef = useRef<string>("");

  const sendTextMessage = async (client: RTVIClient, message: string) => {
    const content: Message["content"]["content"] = [
      {
        type: "text",
        text: message,
      },
    ];

    emitter.emit("userTextMessage", [
      ...content,
      ...(previewUrls.length
        ? previewUrls.map<ImageContent>((url) => ({
            type: "image_url",
            image_url: {
              url,
            },
          }))
        : []),
    ]);
    setPreviewUrls([]);
    setText("");

    if (attachmentIds.length) {
      // If attachments are present, add them to the request data
      client.params.requestData = {
        ...(client.params.requestData ?? {}),
        attachments: [...attachmentIds],
      };
      setAttachmentIds([]);
    }

    try {
      await client?.action({
        service: "llm",
        action: "append_to_messages",
        arguments: [
          {
            name: "messages",
            value: [
              {
                role: "user",
                content,
              },
            ],
          },
        ],
      });
    } catch (e) {
      if (e instanceof RTVIMessage) {
        console.error(e.data);
      }
    } finally {
      setProcessingAction(false);

      // Remove attachments from request data
      client.params.requestData = {
        ...(client.params.requestData ?? {}),
        attachments: undefined,
      };
    }
  };

  const createConversation = useCallback(
    async (voice: boolean) => {
      if (!rtviClient) return;

      const response = await fetch(
        `${import.meta.env.VITE_SERVER_URL}/conversations`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({}),
        },
      );
      if (response.ok) {
        const json = await response.json();
        const newConversationId = json.conversation_id;

        newConversationIdRef.current = newConversationId;

        rtviClient.params.requestData = {
          ...(rtviClient.params.requestData ?? {}),
          conversation_id: newConversationId,
        };

        emitter.emit("updateSidebar");
        if (voice) {
          setConversationId(newConversationId);
        }

        return newConversationId;
      }
      return null;
    },
    [rtviClient, setConversationId],
  );

  const handleTextSubmit = async (ev: FormEvent<HTMLFormElement>) => {
    ev.preventDefault();

    if (processingAction || isUploadingFile || !rtviClient) return;

    setProcessingAction(true);

    const message = text.trim();

    if (!conversationId) {
      emitter.emit("showChatMessages");
      const newConversationId = await createConversation(false);
      rtviClient.once("botLlmStopped", () => {
        setConversationId(newConversationId);
      });
    }
    sendTextMessage(rtviClient, message);
  };

  const handleConnect = useCallback(() => {
    setIsVoiceMode(true);
    setIsMicMuted(false);
    rtviClient?.enableMic(true);
    onChangeMode?.(true);
    setEndDate(new Date(Number(rtviClient?.transportExpiry) * 1000));
  }, [onChangeMode, rtviClient]);

  const handleDisconnect = useCallback(() => {
    setIsVoiceMode(false);
    setIsMicMuted(false);
    rtviClient?.enableCam(false);
    rtviClient?.enableMic(false);
    onChangeMode?.(false);
    setEndDate(null);
  }, [onChangeMode, rtviClient]);

  useRTVIClientEvent(RTVIEvent.Connected, handleConnect);
  useRTVIClientEvent(RTVIEvent.Disconnected, handleDisconnect);

  const handleSwitchToTextMode = useCallback(() => {
    setIsVoiceMode(false);
    rtviClient?.disconnect();
  }, [rtviClient]);
  const handleSwitchToVoiceMode = useCallback(
    async (createIfNew = true) => {
      if (!rtviClient) return;
      setIsVoiceMode(true);
      setError("");
      if (!conversationId && createIfNew) {
        await createConversation(true);
        // Allow requestData to be updated before connecting
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      try {
        await rtviClient?.connect();
        emitter.emit("showChatMessages");
      } catch (e) {
        console.error(e);
        setError("An error occurred while trying to start voice mode.");
        handleSwitchToTextMode();
      }
    },
    [conversationId, createConversation, handleSwitchToTextMode, rtviClient],
  );

  useRTVIClientEvent(
    RTVIEvent.Error,
    useCallback(
      (message: RTVIMessage) => {
        console.error(message);
        setError("An error occurred during the voice session.");
        handleSwitchToTextMode();
      },
      [handleSwitchToTextMode],
    ),
  );

  // Toggle webcam
  const handleCamToggle = useCallback(() => {
    if (!isScreenMuted) {
      // If screen sharing is on, turn it off
      handleScreenToggle();
    }

    setIsCamMuted((muted: boolean) => {
      rtviClient?.enableCam(muted);
      return !muted;
    });
  }, [rtviClient, isScreenMuted]);

  // Toggle screen sharing
  const handleScreenToggle = useCallback(() => {
    if (!isCamMuted) {
      // If camera is on, turn it off
      handleCamToggle();
    }

    setIsScreenMuted((muted: boolean) => {
      rtviClient?.enableScreenShare(muted);
      return !muted;
    });
  }, [rtviClient, isCamMuted]);

  // Toggle between mic mute and unmute in voice mode
  const handleMicToggle = useCallback(() => {
    setIsMicMuted((muted) => {
      rtviClient?.enableMic(muted);
      return !muted;
    });
  }, [rtviClient]);

  // Handle image selection
  const handleImageChange = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const files = Array.from(event.target.files ?? []);
    if (files.length) {
      const allowedFiles: File[] = [];
      let total = 0;
      let notifyUser = false;
      files.forEach((file) => {
        if (total + file.size < MAX_TOTAL_FILE_SIZE) {
          allowedFiles.push(file);
          total += file.size;
        } else {
          notifyUser = true;
        }
      });

      setSelectedImages((images) => [...images, ...allowedFiles]);
      allowedFiles.forEach((f) => {
        const reader = new FileReader();
        reader.onload = (e) => {
          const base64String = e.target?.result?.toString();
          if (base64String) {
            handleUploadFile(f, base64String);
            setPreviewUrls((urls) => [...urls, base64String]);
          }
        };
        reader.readAsDataURL(f);
      });
      if (notifyUser) {
        toast({
          title: `Exceeded maximum allowed attachment size of ${getHumanReadableFilesize(
            MAX_TOTAL_FILE_SIZE,
          )}`,
        });
      }
    }
    event.target.value = "";
  };

  // Remove the selected image
  const handleRemoveImage = (idx: number) => {
    setAttachmentIds((attachmentIds) => {
      const newIds = [...attachmentIds];
      newIds.splice(idx, 1);
      return newIds;
    });
    setSelectedImages((images) => {
      const newImages = [...images];
      newImages.splice(idx, 1);
      return newImages;
    });
    setPreviewUrls((urls) => {
      const newUrls = [...urls];
      const base64 = urls[idx];
      const xhr = xhrsRef.current[base64];
      if (xhr) xhr.abort();
      setUploadProgress((p) => {
        const newP = { ...p };
        delete newP[base64];
        return newP;
      });
      newUrls.splice(idx, 1);
      return newUrls;
    });
  };

  const handleUploadFile = async (file: File, base64: string) => {
    const formData = new FormData();
    formData.append("file", file);

    try {
      const xhr = new XMLHttpRequest();
      xhrsRef.current[base64] = xhr;

      xhr.upload.addEventListener("progress", (event) => {
        if (event.lengthComputable) {
          const percentComplete = (event.loaded / event.total) * 100;
          setUploadProgress((p) => ({
            ...p,
            [base64]: percentComplete,
          }));
        }
      });

      xhr.addEventListener("load", () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          setUploadProgress((p) => ({
            ...p,
            [base64]: "done",
          }));
          const json = JSON.parse(xhr.responseText);
          setAttachmentIds((ids) => [...ids, json.attachment_id]);
        } else {
          setUploadProgress((p) => ({
            ...p,
            [base64]: "error",
          }));
        }
      });

      xhr.addEventListener("error", () => {
        setUploadProgress((p) => ({
          ...p,
          [base64]: "error",
        }));
      });

      xhr.addEventListener("abort", () => {
        setUploadProgress((p) => ({
          ...p,
          [base64]: "error",
        }));
      });

      xhr.open(
        "POST",
        `${import.meta.env.VITE_SERVER_URL}/conversations/upload`,
      );
      xhr.send(formData);
    } catch {
      setUploadProgress((p) => ({
        ...p,
        [base64]: "error",
      }));
      return null;
    }
  };

  useEffect(() => {
    if (previewUrls.length) return;
    setImageZoom(false);
    setStartIndex(0);
  }, [previewUrls.length]);

  const feedbackClassName =
    "bg-gradient-to-t from-background absolute w-full bottom-full pt-4 pb-2 flex gap-2 items-center justify-center z-10";

  const ToggledMicIcon = isMicMuted ? MicOffIcon : MicIcon;

  const camTrack = useRTVIClientMediaTrack("video", "local");

  const isConnecting =
    transportState === "authenticating" ||
    transportState === "connecting" ||
    transportState === "connected";

  const isUploadingFile = Object.values(uploadProgress).some(
    (s) => typeof s === "number",
  );

  return (
    <div className="relative w-full px-4">
      <BotReadyAudio active={isVoiceMode} />
      <Dialog open={imageZoom} onOpenChange={setImageZoom}>
        <DialogContent
          noCloseButton
          className="border-none bg-transparent shadow-none p-12 max-w-none w-[100dvw] max-h-[100dvh]"
        >
          <DialogTitle className="sr-only">Image preview</DialogTitle>
          <DialogClose className="top-4 right-2 absolute">
            <X className="text-white" />
          </DialogClose>
          <Carousel
            className={cn("relative h-[calc(100dvh-6rem)] w-100", {
              "mx-8": previewUrls.length > 1,
            })}
            opts={{
              loop: true,
              startIndex,
            }}
          >
            <CarouselContent className="items-center">
              {previewUrls.map((url, idx) => (
                <CarouselItem
                  key={idx}
                  className="relative h-[calc(100dvh-6rem)] overflow-hidden"
                >
                  <img
                    src={url}
                    alt="Selected Preview"
                    className="object-contain h-full w-full"
                  />
                </CarouselItem>
              ))}
            </CarouselContent>
            {previewUrls.length > 1 && (
              <>
                <CarouselPrevious />
                <CarouselNext />
              </>
            )}
          </Carousel>
        </DialogContent>
      </Dialog>

      {!webrtcEnabled ? (
        <div className={cn(feedbackClassName, "text-destructive")}>
          <TriangleAlertIcon />
          <span>
            Missing <code>DAILY_API_KEY</code>
          </span>
        </div>
      ) : error ? (
        <div className={feedbackClassName}>
          <TriangleAlertIcon />
          <span>{error}</span>
        </div>
      ) : isConnecting ? (
        <div className={feedbackClassName}>
          <LoaderCircle className="animate-spin" />
          <span>Connecting…</span>
        </div>
      ) : transportState === "ready" ? (
        <div className={feedbackClassName}>
          <span>
            {isMicMuted
              ? "Tap to unmute"
              : processingAction
                ? "Thinking…"
                : "Listening"}
          </span>
          {endDate && (
            <div>
              <span className="select-none tabular-nums font-mono">
                <ExpiryCountdown endDate={endDate} />
              </span>
            </div>
          )}
        </div>
      ) : processingAction ? (
        <div className={feedbackClassName}>
          <LoaderCircle className="animate-spin" />
        </div>
      ) : null}

      <div className="bg-secondary rounded-3xl flex flex-col gap-1 p-2">
        {/* Image Preview (if an image is selected) */}
        {previewUrls.length > 0 && (
          <div className="relative w-full flex justify-start gap-2 mt-2 px-2">
            {previewUrls.map((url, idx) => (
              <div key={idx + url} className="relative inline-block">
                <img
                  src={url}
                  alt="Selected Preview"
                  className="bg-muted cursor-zoom-in h-12 w-12 object-cover rounded-lg"
                  onClick={() => {
                    setStartIndex(idx);
                    setImageZoom(true);
                  }}
                  height={80}
                  width={80}
                />
                {/* Remove button */}
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => handleRemoveImage(idx)}
                        className="absolute -top-2 -right-2 rounded-full focus:outline-none bg-secondary p-1 h-6 w-6"
                      >
                        {typeof uploadProgress[url] === "number" ? (
                          <span
                            className="rounded-full absolute left-0 top-0 w-full h-full p-1 overflow-hidden"
                            style={{
                              background:
                                typeof uploadProgress[url] === "number"
                                  ? `conic-gradient(hsl(var(--primary)) ${Math.round((uploadProgress[url] / 100) * 360)}deg, white 0deg)`
                                  : undefined,
                            }}
                          >
                            <UploadCloudIcon className="bg-foreground text-background rounded-full w-4 h-4" />
                          </span>
                        ) : uploadProgress[url] === "error" ? (
                          <AlertCircleIcon className="bg-secondary text-destructive rounded-full w-4 h-4" />
                        ) : (
                          <X className="bg-foreground text-background rounded-full w-4 h-4" />
                        )}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent className="bg-popover text-popover-foreground">
                      {typeof uploadProgress[url] === "number"
                        ? "Abort upload"
                        : uploadProgress[url] === "error"
                          ? "Error while uploading"
                          : "Remove image"}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
            ))}
          </div>
        )}

        <form
          ref={formRef}
          className="relative w-full flex ps-4"
          id="text-chat-form"
          onSubmit={handleTextSubmit}
        >
          <Textarea
            autoFocus
            className="!border-0 !border-none !shadow-none !outline-none !ring-0 text-base min-h-0 h-auto max-h-32 p-0 py-2 resize-none"
            disabled={!webrtcEnabled}
            onChange={(ev) => setText(ev.currentTarget.value)}
            onKeyDown={handleTextKeyDown}
            required
            placeholder="Type message here"
            value={text}
            rows={text.split("\n").length}
          />
          <Button
            className={cn(
              "flex-none bg-background rounded-full scale-0 opacity-0 transition-all",
              {
                "scale-100 opacity-100": text,
              },
            )}
            disabled={!webrtcEnabled || isUploadingFile}
            size="icon"
            variant="outline"
            type="submit"
          >
            <ArrowUpIcon size={24} />
          </Button>
        </form>

        {/* Video preview */}
        {vision && isVoiceMode && !isCamMuted && (
          <div
            className={cn(
              "absolute shadow-lg z-20 bottom-full -translate-y-2 max-w-40 bg-secondary rounded-2xl aspect-video overflow-hidden transition-all",
              {
                "max-w-80": videoSize === "large",
                "left-0": videoPlacement === "left",
                "right-0": videoPlacement === "right",
              },
            )}
          >
            <RTVIClientVideo
              trackType="video"
              participant="local"
              fit="cover"
              className="w-full h-full"
            />
            {!camTrack && (
              <div className="absolute top-0 left-0 z-10 w-full h-full flex items-center justify-center">
                <LoaderCircleIcon className="animate-spin" size={16} />
              </div>
            )}
            <Button
              className="absolute top-1 right-1 rounded-full !text-background bg-foreground/10 hover:bg-foreground/50 focus-visible:bg-foreground/50"
              size="icon"
              variant="ghost"
              onClick={() =>
                setVideoSize((vs) => (vs === "small" ? "large" : "small"))
              }
            >
              {videoSize === "small" ? (
                <Maximize2Icon size={16} />
              ) : (
                <Minimize2Icon size={16} />
              )}
            </Button>
            <Button
              className={cn(
                "absolute bottom-1 rounded-full !text-background bg-foreground/10 hover:bg-foreground/50 focus-visible:bg-foreground/50",
                {
                  "right-1": videoPlacement === "left",
                  "left-1": videoPlacement === "right",
                },
              )}
              size="icon"
              variant="ghost"
              onClick={() =>
                setVideoPlacement((vp) => (vp === "left" ? "right" : "left"))
              }
            >
              {videoPlacement === "left" ? (
                <ArrowRightToLineIcon size={16} />
              ) : (
                <ArrowLeftToLineIcon size={16} />
              )}
            </Button>
          </div>
        )}

        {/* Chat Controls */}
        <div className="flex gap-2 justify-between sm:grid sm:grid-cols-3">
          <div className="flex items-end gap-2">
            {/* Image Button (File picker with camera support on mobile) */}
            {transportState === "disconnected" && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      className="rounded-full relative"
                      size="icon"
                      variant="secondary-outline"
                    >
                      <PaperclipIcon />
                      <input
                        type="file"
                        accept="image/*"
                        multiple
                        className="absolute inset-0 opacity-0 file:cursor-pointer file:inset-0 file:absolute"
                        onChange={handleImageChange}
                      />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent className="bg-background text-foreground shadow-sm">
                    Attach images
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}

            {/* Cam button for mute/unmute */}
            {vision && isVoiceMode && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      size="icon"
                      variant="secondary-outline"
                      onClick={handleCamToggle}
                      className={cn("rounded-full", {
                        "bg-primary hover:bg-primary text-primary-foreground":
                          !isCamMuted,
                      })}
                      disabled={transportState !== "ready"}
                    >
                      <WebcamIcon size={24} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent className="bg-background text-foreground shadow-sm">
                    {isCamMuted ? "Turn on camera" : "Turn off camera"}
                  </TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      size="icon"
                      variant="secondary-outline"
                      onClick={handleScreenToggle}
                      className={cn("rounded-full", {
                        "bg-primary hover:bg-primary text-primary-foreground":
                          !isScreenMuted,
                      })}
                      disabled={transportState !== "ready"}
                    >
                      <ScreenShareIcon size={24} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent className="bg-background text-foreground shadow-sm">
                    {isScreenMuted ? "Turn on camera" : "Turn off camera"}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>

          <div className="mr-auto sm:mr-0 sm:justify-self-center">
            {/* Mic button for mute/unmute */}
            {isVoiceMode && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      size="icon"
                      variant="secondary-outline"
                      onClick={handleMicToggle}
                      className={cn(
                        "py-1 px-2 rounded-full focus:outline-none hover:bg-secondary flex justify-between gap-1 items-center w-24",
                        {
                          "bg-destructive hover:bg-destructive text-destructive-foreground":
                            isMicMuted,
                        },
                      )}
                    >
                      <ToggledMicIcon className="flex-none" size={24} />
                      {isMicMuted ? (
                        <span className="font-semibold uppercase">Muted</span>
                      ) : (
                        <VoiceVisualizer
                          backgroundColor="transparent"
                          barColor={isMicMuted ? "gray" : "black"}
                          barGap={3}
                          barWidth={8}
                          barMaxHeight={20}
                          participantType="local"
                        />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent className="bg-background text-foreground shadow-sm">
                    {isMicMuted ? "Unmute microphone" : "Mute microphone"}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>

          <div className="justify-self-end flex items-end gap-3 relative">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    onClick={
                      isVoiceMode
                        ? handleSwitchToTextMode
                        : () => handleSwitchToVoiceMode()
                    }
                    disabled={!webrtcEnabled || isConnecting}
                    size="icon"
                    variant={isVoiceMode ? "destructive" : "secondary-outline"}
                    type="button"
                    className={cn("flex-none bg-background rounded-full", {
                      "bg-secondary": isConnecting,
                      "bg-foreground": isVoiceMode,
                    })}
                  >
                    {isConnecting ? (
                      <LoaderCircleIcon
                        className="animate-spin rounded-full bg-muted text-background p-1"
                        size={24}
                      />
                    ) : isVoiceMode ? (
                      <XIcon size={24} />
                    ) : (
                      <Speech size={24} />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent
                  align="center"
                  className="bg-background text-foreground shadow-sm"
                >
                  {isVoiceMode ? "End voice mode" : "Enable voice mode"}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ChatControls;
