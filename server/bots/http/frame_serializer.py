import base64
import json

from loguru import logger
from pipecat.frames.frames import Frame, TransportMessageUrgentFrame
from pipecat.serializers.base_serializer import FrameSerializer, FrameSerializerType


def encode_response(data: str | dict) -> str:
    data = data if isinstance(data, str) else json.dumps(data)
    encoded = base64.b64encode(data.encode("utf-8")).decode("utf-8")
    return f"data: {encoded}\n\n"


class BotFrameSerializer(FrameSerializer):
    def __init__(self):
        super().__init__()

    @property
    def type(self) -> FrameSerializerType:
        return FrameSerializerType.TEXT

    async def serialize(self, frame: Frame) -> str | bytes | None:
        if isinstance(frame, TransportMessageUrgentFrame):
            logger.debug(f"Serializing urgent frame: {str(frame.message)[:120]}...")
            return encode_response(frame.message)

    async def deserialize(self, data: str | bytes) -> Frame | None:
        return None
