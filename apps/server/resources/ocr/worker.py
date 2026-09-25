"""One page per process. JSON stdin/stdout; no file reads from document-supplied paths."""
import argparse
import base64
import contextlib
import io
import json
import os
from pathlib import Path
import platform
import sys

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["TOKENIZERS_PARALLELISM"] = "false"


def recognize(args):
    from PIL import Image
    Image.MAX_IMAGE_PIXELS = 40_000_000
    raw = sys.stdin.buffer.read(28 * 1024 * 1024 + 1)
    if len(raw) > 28 * 1024 * 1024:
        raise ValueError("Input too large")
    request = json.loads(raw)
    data = base64.b64decode(request["image"], validate=True)
    image = Image.open(io.BytesIO(data))
    if image.format not in {"PNG", "JPEG", "WEBP"}:
        raise ValueError("Unsupported image")
    if image.width * image.height > 40_000_000 or (image.width, image.height) != (request["width"], request["height"]):
        raise ValueError("Invalid image dimensions")
    image = image.convert("RGB")
    manifest = json.loads((args.model_dir / (args.model + ".json")).read_text())
    if manifest["version"] != 1 or manifest["model"] != args.model:
        raise FileNotFoundError("Invalid model manifest")
    if args.model == "pp-ocrv6-small":
        for key in ("det", "rec", "cls", "keys"):
            if not Path(manifest[key]).is_file():
                raise FileNotFoundError("Missing model asset")
        import numpy as np
        from rapidocr import RapidOCR
        engine = RapidOCR(params={
            "Det.model_path": manifest["det"], "Rec.model_path": manifest["rec"], "Cls.model_path": manifest["cls"],
            "Rec.rec_keys_path": manifest["keys"],
            "Global.use_cls": False, "EngineConfig.onnxruntime.intra_op_num_threads": 4,
            "EngineConfig.onnxruntime.inter_op_num_threads": 1,
        })
        # RapidOCR's ndarray entry point expects OpenCV BGR, not PIL RGB.
        result = engine(np.array(image)[:, :, ::-1], use_cls=False)
        texts = list(result.txts) if result.txts is not None else []
        regions = []
        if result.boxes is not None:
            for index, (text, points) in enumerate(zip(texts, result.boxes)):
                x0 = max(0.0, min(float(p[0]) for p in points) / image.width)
                y0 = max(0.0, min(float(p[1]) for p in points) / image.height)
                x1 = min(1.0, max(float(p[0]) for p in points) / image.width)
                y1 = min(1.0, max(float(p[1]) for p in points) / image.height)
                if x1 > x0 and y1 > y0:
                    region = {"text": text, "box": {"x": x0, "y": y0, "width": x1 - x0, "height": y1 - y0}}
                    if result.scores is not None:
                        region["confidence"] = float(result.scores[index])
                    regions.append(region)
        return {"text": "\n".join(texts), "regions": regions, "truncated": False}

    if platform.system() != "Darwin" or platform.machine() != "arm64":
        raise ModuleNotFoundError("Quality OCR requires Apple Silicon")
    model_path = Path(manifest["path"])
    if not model_path.is_dir():
        raise FileNotFoundError("Missing quality model")
    from mlx_vlm import load, generate
    from mlx_vlm.prompt_utils import apply_chat_template
    model, processor = load(str(model_path))
    config = json.loads((model_path / "config.json").read_text())
    prompt = apply_chat_template(processor, config, "OCR:", num_images=1)
    result = generate(model, processor, prompt, image=image, max_tokens=4096, temperature=0, verbose=False)
    return {"text": result.text, "regions": [], "truncated": result.finish_reason == "length"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", choices=["pp-ocrv6-small", "paddleocr-vl-1.6"], required=True)
    parser.add_argument("--model-dir", type=Path, required=True)
    arguments = parser.parse_args()
    try:
        with contextlib.redirect_stdout(sys.stderr):
            output = recognize(arguments)
        print(json.dumps(output, ensure_ascii=False, allow_nan=False))
    except (FileNotFoundError, ModuleNotFoundError):
        print("Local OCR runtime or model is not prepared", file=sys.stderr)
        sys.exit(3)
    except Exception:
        # Do not put document content or exception internals into application logs.
        print("Local OCR processing failed", file=sys.stderr)
        sys.exit(4)
