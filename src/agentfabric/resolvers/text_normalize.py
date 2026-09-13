from __future__ import annotations

import re
from typing import Any


def resolve(ctx: Any, input_value: dict[str, Any]) -> dict[str, Any]:
    del ctx
    text = input_value["text"].replace("\r\n", "\n").replace("\r", "\n").strip()
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return {"text": text}
