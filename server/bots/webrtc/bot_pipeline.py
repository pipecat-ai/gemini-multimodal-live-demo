from typing import Any

from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.frameworks.rtvi import RTVIObserver

from bots.persistent_context import PersistentContext
from bots.rtvi import create_rtvi_processor
from bots.types import BotCallbacks, BotConfig, BotParams
from common.config import SERVICE_API_KEYS
from common.models import Conversation, Message
from loguru import logger
from openai._types import NOT_GIVEN
from sqlalchemy.ext.asyncio import AsyncSession

from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.pipeline.pipeline import Pipeline
from pipecat.services.ai_services import OpenAILLMContext
from pipecat.services.gemini_multimodal_live.gemini import (
    GeminiMultimodalLiveLLMService,
)
from pipecat.transports.services.daily import DailyParams, DailyTransport


async def bot_pipeline_task(
    params: BotParams,
    config: BotConfig,
    callbacks: BotCallbacks,
    room_url: str,
    room_token: str,
    db: AsyncSession,
) -> PipelineTask:
    transport = DailyTransport(
        room_url,
        room_token,
        "Gemini Bot",
        DailyParams(
            audio_in_sample_rate=16000,
            audio_out_enabled=True,
            audio_out_sample_rate=24000,
            transcription_enabled=False,
            vad_enabled=True,
            vad_analyzer=SileroVADAnalyzer(params=VADParams(stop_secs=0.5)),
            vad_audio_passthrough=True,
        ),
    )

    conversation = await Conversation.get_conversation_by_id(params.conversation_id, db)
    if not conversation:
        raise Exception(f"Conversation {params.conversation_id} not found")
    messages = [getattr(msg, "content") for msg in conversation.messages]

    #
    # RTVI
    #

    llm_rt = GeminiMultimodalLiveLLMService(
        api_key=str(SERVICE_API_KEYS["gemini"]),
        voice_id="Aoede",  # Puck, Charon, Kore, Fenrir, Aoede
        # system_instruction="Talk like a pirate."
        transcribe_user_audio=True,
        transcribe_model_audio=True,
        inference_on_context_initialization=False,
    )

    tools = NOT_GIVEN  # todo: implement tools in and set here
    context_rt = OpenAILLMContext(messages, tools)
    context_aggregator_rt = llm_rt.create_context_aggregator(context_rt)
    user_aggregator = context_aggregator_rt.user()
    assistant_aggregator = context_aggregator_rt.assistant()
    await llm_rt.set_context(context_rt)
    storage = PersistentContext(context=context_rt)

    rtvi = await create_rtvi_processor(config, user_aggregator)

    processors = [
        transport.input(),
        rtvi,
        user_aggregator,
        llm_rt,
        transport.output(),
        assistant_aggregator,
        storage.create_processor(exit_on_endframe=True),
    ]

    pipeline = Pipeline(processors)

    @storage.on_context_message
    async def on_context_message(messages: list[Any]):
        logger.debug(f"{len(messages)} message(s) received for storage")
        try:
            await Message.create_messages(
                db_session=db, conversation_id=params.conversation_id, messages=messages
            )
        except Exception as e:
            logger.error(f"Error storing messages: {e}")
            raise e

    @rtvi.event_handler("on_client_ready")
    async def on_client_ready(rtvi):
        await rtvi.set_bot_ready()
        for message in params.actions:
            await rtvi.handle_message(message)

    @transport.event_handler("on_first_participant_joined")
    async def on_first_participant_joined(transport, participant):
        # Enable both camera and screenshare. From the client side
        # send just one.
        await transport.capture_participant_video(
            participant["id"], framerate=1, video_source="camera"
        )
        await transport.capture_participant_video(
            participant["id"], framerate=1, video_source="screenVideo"
        )
        await callbacks.on_first_participant_joined(participant)

    @transport.event_handler("on_participant_joined")
    async def on_participant_joined(transport, participant):
        await callbacks.on_participant_joined(participant)

    @transport.event_handler("on_participant_left")
    async def on_participant_left(transport, participant, reason):
        await callbacks.on_participant_left(participant, reason)

    @transport.event_handler("on_call_state_updated")
    async def on_call_state_updated(transport, state):
        await callbacks.on_call_state_updated(state)

    task = PipelineTask(
        pipeline,
        params=PipelineParams(
            allow_interruptions=True,
            enable_metrics=True,
            send_initial_empty_metrics=False,
        ),
        observers=[RTVIObserver(rtvi)]
    )

    return task
