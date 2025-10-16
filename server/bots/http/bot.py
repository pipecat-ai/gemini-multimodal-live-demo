import asyncio
from typing import Any, AsyncGenerator, List, Tuple

from bots.http.frame_serializer import BotFrameSerializer
from bots.persistent_context import PersistentContext
from bots.rtvi import create_rtvi_processor
from bots.types import BotConfig, BotParams
from common.config import SERVICE_API_KEYS
from common.models import Attachment, Message
from fastapi import HTTPException, status
from loguru import logger
from openai._types import NOT_GIVEN
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineTask
from pipecat.processors.async_generator import AsyncGeneratorProcessor
from pipecat.processors.frameworks.rtvi import (
    RTVIActionRun,
    RTVIMessage,
    RTVIObserver,
    RTVIProcessor,
)
from pipecat.services.ai_services import OpenAILLMContext
from pipecat.services.google import GoogleLLMContext, GoogleLLMService
from sqlalchemy.ext.asyncio import AsyncSession


async def http_bot_pipeline(
    params: BotParams,
    config: BotConfig,
    messages,
    attachments: List[Attachment],
    db: AsyncSession,
    language_code: str = "english",
) -> Tuple[AsyncGenerator[Any, None], Any]:
    llm_api_key = SERVICE_API_KEYS.get("gemini")
    if llm_api_key is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Service `llm` not available in SERVICE_API_KEYS. Please check your environment variables.",
        )

    llm = GoogleLLMService(
        api_key=str(SERVICE_API_KEYS["gemini"]),
        model="gemini-2.0-flash-exp",
    )

    tools = NOT_GIVEN
    context = OpenAILLMContext(messages, tools)
    context_aggregator = llm.create_context_aggregator(
        context, assistant_expect_stripped_words=False
    )
    # Terrible hack. Fix this by making create_context_aggregator downcast the context
    # automatically. But think through that code first to make sure there won't be
    # any unintended consequences.
    if isinstance(llm, GoogleLLMService):
        GoogleLLMContext.upgrade_to_google(context)
    user_aggregator = context_aggregator.user()
    assistant_aggregator = context_aggregator.assistant()

    storage = PersistentContext(context=context)

    async_generator = AsyncGeneratorProcessor(serializer=BotFrameSerializer())

    #
    # RTVI
    #

    rtvi = await create_rtvi_processor(config, user_aggregator)

    #
    # Processing
    #

    processors = [
        rtvi,
        user_aggregator,
        storage.create_processor(),
        llm,
        async_generator,
        assistant_aggregator,
        storage.create_processor(exit_on_endframe=True),
    ]

    pipeline = Pipeline(processors)

    runner = PipelineRunner(handle_sigint=False)

    task = PipelineTask(pipeline, observers=[RTVIObserver(rtvi)])

    runner_task = asyncio.create_task(runner.run(task))

    @storage.on_context_message
    async def on_context_message(messages: list[Any]):
        logger.debug(f"{len(messages)} message(s) received for storage: {str(messages)[:120]}...")
        try:
            await Message.create_messages(
                db_session=db,
                conversation_id=params.conversation_id,
                messages=messages,
                language_code=language_code,
            )
        except Exception as e:
            logger.error(f"Error storing messages: {e}")
            raise e

    @rtvi.event_handler("on_bot_started")
    async def on_bot_started(rtvi: RTVIProcessor):
        for action in params.actions:
            logger.debug(f"Processing action: {action}")

            # If this is an append_to_messages action, we need to append any
            # attachments. The rule we'll follow is that we should append
            # attachments to the first "user" message in the actions list.
            if action.data.get("action") == "append_to_messages" and attachments:
                for msg in action.data["arguments"][0]["value"]:
                    if msg.get("role") == "user":
                        # Append attachments to this message
                        logger.debug(
                            f"Appending {len(attachments)} attachment(s) to 'user' message"
                        )
                        content = msg.get("content", "")
                        if isinstance(content, str):
                            content = [{"type": "text", "text": content}]
                        for attachment in attachments:
                            # Assume for the moment that all attachments are images
                            content.append(
                                {
                                    "type": "image_url",
                                    "image_url": {
                                        "url": f"data:{attachment.file_type};base64,{attachment.file_data}"
                                    },
                                }
                            )
                            await db.delete(attachment)
                            await db.commit()
                        break

            await rtvi.handle_message(action)

        # This is a single turn, so we just push an action to stop the running
        # pipeline task.
        action = RTVIActionRun(service="system", action="end")
        message = RTVIMessage(type="action", id="END", data=action.model_dump())
        await rtvi.handle_message(message)

    return (async_generator.generator(), runner_task)
