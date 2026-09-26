"""Explicit provisioning only. Downloads pinned models; extraction never provisions them."""
import argparse
import contextlib
import json
import os
from pathlib import Path
import platform
import tempfile


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", choices=["pp-ocrv6-small", "paddleocr-vl-1.6"], required=True)
    parser.add_argument("--model-dir", type=Path, required=True)
    args = parser.parse_args()
    root = args.model_dir.resolve()
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    from huggingface_hub import snapshot_download

    manifest = {"version": 1, "model": args.model}
    with contextlib.redirect_stdout(__import__("sys").stderr):
        if args.model == "pp-ocrv6-small":
            from rapidocr import RapidOCR
            import yaml
            models = {
                "det": ("PaddlePaddle/PP-OCRv6_small_det_onnx", "28fe5895c24fd108c19eb3e8479f4ab385fbfc62"),
                "rec": ("PaddlePaddle/PP-OCRv6_small_rec_onnx", "b8f84f0b80c529de40b4fbb3544b84fa7233a513"),
            }
            for key, (repo, revision) in models.items():
                snapshot = Path(snapshot_download(repo, revision=revision, allow_patterns=["*.onnx", "*.yml", "*.json", "README.md"]))
                manifest[key] = str(snapshot / "inference.onnx")
                manifest[key + "_source"] = {"repo": repo, "revision": revision}
                if key == "rec":
                    characters = yaml.safe_load((snapshot / "inference.yml").read_text())["PostProcess"]["character_dict"]
                    dictionary = root / "pp-ocrv6-small-keys.txt"
                    dictionary.write_text("\n".join(characters) + "\n", encoding="utf8")
                    manifest["keys"] = str(dictionary)
            # RapidOCR constructs its orientation classifier even when classification is off.
            # Provision it now, and pass its explicit path during offline extraction.
            asset_dir = root / "rapidocr-assets"
            RapidOCR(params={"Det.model_path": manifest["det"], "Rec.model_path": manifest["rec"],
                             "Rec.rec_keys_path": manifest["keys"], "Global.model_root_dir": str(asset_dir), "Global.use_cls": False})
            classifier = asset_dir / "ch_ppocr_mobile_v2.0_cls_mobile.onnx"
            if not classifier.is_file():
                raise RuntimeError("RapidOCR classifier asset was not provisioned")
            manifest["cls"] = str(classifier)
        else:
            if platform.system() != "Darwin" or platform.machine() != "arm64":
                raise RuntimeError("The quality runtime currently requires Apple Silicon; use fast OCR or a server on this host")
            repo = "matrixmaven/PaddleOCR-VL-1.6-bf16"
            revision = "7fb1845e6e3ca856ec7788c4ea700cef175ee8ba"
            manifest.update(repo=repo, revision=revision, path=snapshot_download(
                repo, revision=revision, allow_patterns=["*.safetensors", "*.json", "*.txt", "*.model", "*.jinja", "README.md"]))
    with tempfile.NamedTemporaryFile("w", dir=root, delete=False, encoding="utf8") as temporary:
        json.dump(manifest, temporary, indent=2)
        temporary_path = temporary.name
    os.replace(temporary_path, root / (args.model + ".json"))
    print(f"Prepared {args.model} in {root}")


if __name__ == "__main__":
    main()
