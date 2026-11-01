"""Amazon Bedrock backend: Titan Image Generator, called with the broker pod's own
IRSA identity (no secret of ours to hold — `contribs.imagegen.backends.bedrock.roleArn`
only annotates the service account; boto3 picks the credentials up automatically).
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging

import boto3

from ..config import ImagegenSettings
from ..manifest import Backend, BackendManifest, GenerateRequest, ModelManifest

logger = logging.getLogger(__name__)

_PARAMS_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "quality": {"type": "string", "enum": ["standard", "premium"], "description": "Default: standard."},
        "width": {"type": "integer", "enum": [512, 768, 1024], "description": "Default: 1024."},
        "height": {"type": "integer", "enum": [512, 768, 1024], "description": "Default: 1024."},
        "seed": {"type": "integer", "minimum": 0, "maximum": 2147483646},
        "negative_text": {"type": "string", "description": "What to avoid in the image."},
    },
}

_MANIFEST = BackendManifest(
    models=(
        ModelManifest(
            name="amazon.titan-image-generator-v2:0",
            description=(
                "Amazon Titan Image Generator v2 — general-purpose text-to-image, and "
                "image-to-image variation when reference_image_path is set."
            ),
            params_schema=_PARAMS_SCHEMA,
        ),
    ),
)


class BedrockBackend:
    name = "bedrock"
    manifest = _MANIFEST

    def __init__(self, region: str) -> None:
        self._client = boto3.client("bedrock-runtime", region_name=region)

    async def generate(self, request: GenerateRequest) -> list[bytes]:
        config = {
            "numberOfImages": request.n,
            "quality": request.params.get("quality", "standard"),
            "width": request.params.get("width", 1024),
            "height": request.params.get("height", 1024),
        }
        if "seed" in request.params:
            config["seed"] = request.params["seed"]

        if request.reference_image is None:
            body = {
                "taskType": "TEXT_IMAGE",
                "textToImageParams": {
                    "text": request.prompt,
                    **({"negativeText": request.params["negative_text"]} if "negative_text" in request.params else {}),
                },
                "imageGenerationConfig": config,
            }
        else:
            body = {
                "taskType": "IMAGE_VARIATION",
                "imageVariationParams": {
                    "text": request.prompt,
                    "images": [base64.b64encode(request.reference_image).decode()],
                },
                "imageGenerationConfig": config,
            }

        # boto3 is sync; keep it off the event loop so one slow call does not stall the broker.
        response = await asyncio.to_thread(
            self._client.invoke_model,
            modelId=request.model,
            body=json.dumps(body),
        )
        payload = json.loads(response["body"].read())
        return [base64.b64decode(image) for image in payload["images"]]


def factory() -> Backend:
    settings = ImagegenSettings()
    region = settings.backends_config().get("bedrock", {}).get("region", "us-east-1")
    return BedrockBackend(region)
