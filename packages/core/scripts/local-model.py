# /// script
# requires-python = ">=3.11"
# dependencies = ["onnx==1.23.2", "onnxruntime==1.31.0", "onnx-ir==1.1.0", "numpy==2.5.4"]
# ///
"""
Makes the local name finder's files (ADR 22) from urchade/gliner_multi-v2.1 as onnx-community
exports it, so a server holds about 650 MB in memory instead of 1.7 GB:

- The vocabulary keeps only pieces in Latin script (135k of 250k), with the embedding rows and the
  tokenizer renumbered to match. A piece with another script's letters can never match Latin text,
  so Norwegian and English are tokenized exactly as before.
- The embedding is stored in 4 bits (blocks of 16) and the encoder's matrices in 8 bits, weights
  only: the activations stay in full precision, which mDeBERTa needs (dynamic int8 finds nothing).

Run with uv; writes model.onnx, tokenizer.json and tokenizer_config.json to the directory given:
  uv run packages/core/scripts/local-model.py dist/local-model
then publish them where LOCAL_MODEL in src/privacy/deep/local-model.ts points, with its hashes.
"""

import hashlib
import json
import sys
import unicodedata
import urllib.request
from pathlib import Path

import numpy as np
import onnx
from onnx import numpy_helper
from onnxruntime.quantization.matmul_nbits_quantizer import MatMulNBitsQuantizer

SOURCE = "https://huggingface.co/onnx-community/gliner_multi-v2.1/resolve/6ddaeb9413b0e71ad8457da1aab378a165b24058"
FILES = {
    "onnx/model.onnx": "57af7f3d8d72a3ca4e5619c247344b4b5ee362a5ebcf307c0634d67b65e721c0",
    "tokenizer.json": "914bd3c8fb7b525af9e23b60d0ec7b1248ddb2b99014efd9c02ebeb022f8cab7",
    "tokenizer_config.json": "78f866883daf7ee2bc400200a155cdbe9116ed0a6ed597ff573ea2c9862a89a6",
}
# The graph finds the label prompts by this token id, <<ENT>>, written into it as a constant.
ENT_CONSTANT = "/Constant_2"


def fetch(cache: Path, name: str) -> Path:
    path = cache / name.replace("/", "_")
    if not path.exists():
        print(f"downloading {name}")
        urllib.request.urlretrieve(f"{SOURCE}/{name}", path)
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if digest != FILES[name]:
        raise SystemExit(f"{name} isn't the file this script names ({digest})")
    return path


def latin(piece: str) -> bool:
    for ch in piece.replace("▁", ""):
        if ch.isascii() or "LATIN" in unicodedata.name(ch, ""):
            continue
        category = unicodedata.category(ch)
        if category[0] in "PNSZ" and ord(ch) < 0x2100:
            continue
        if category == "Mn" and ord(ch) < 0x370:
            continue
        return False
    return True


def quantize(model, **options):
    quantizer = MatMulNBitsQuantizer(model, is_symmetric=True, **options)
    quantizer.process()
    return quantizer.model.model if hasattr(quantizer.model, "model") else quantizer.model


def main(out: Path) -> None:
    cache = out / ".source"
    cache.mkdir(parents=True, exist_ok=True)
    tokenizer = json.loads(fetch(cache, "tokenizer.json").read_text())
    config = json.loads(fetch(cache, "tokenizer_config.json").read_text())
    model = onnx.load(fetch(cache, "onnx/model.onnx"))

    vocab = tokenizer["model"]["vocab"]
    added = {token["id"] for token in tokenizer["added_tokens"]}
    keep = [i for i, (piece, _) in enumerate(vocab) if i in added or latin(piece)]
    keep += sorted(i for i in added if i >= len(vocab))
    renumber = {old: new for new, old in enumerate(keep)}

    tokenizer["model"]["vocab"] = [vocab[i] for i in keep if i < len(vocab)]
    tokenizer["model"]["unk_id"] = renumber[tokenizer["model"]["unk_id"]]
    for token in tokenizer["added_tokens"]:
        token["id"] = renumber[token["id"]]
    for special in ((tokenizer.get("post_processor") or {}).get("special_tokens") or {}).values():
        special["ids"] = [renumber[i] for i in special["ids"]]
    decoder = config.get("added_tokens_decoder") or {}
    config["added_tokens_decoder"] = {str(renumber[int(k)]): v for k, v in decoder.items()}

    for i, initializer in enumerate(model.graph.initializer):
        if initializer.name.endswith("word_embeddings.weight"):
            rows = numpy_helper.to_array(initializer)[keep]
            model.graph.initializer[i].CopyFrom(numpy_helper.from_array(rows, initializer.name))
    for node in model.graph.node:
        if node.name == ENT_CONSTANT:
            tensor = node.attribute[0].t
            value = numpy_helper.to_array(tensor)
            tensor.CopyFrom(
                numpy_helper.from_array(np.array(renumber[int(value)], dtype=value.dtype), tensor.name)
            )

    model = quantize(model, bits=4, block_size=16, op_types_to_quantize=("Gather",), quant_axes=(("Gather", 1),))
    encoder = [n.name for n in model.graph.node if n.op_type == "MatMul" and "/encoder/layer" in n.name]
    model = quantize(model, bits=8, block_size=32, op_types_to_quantize=("MatMul",), nodes_to_include=encoder)
    # The quantizer raises the opset, under which ReduceMean takes its axes differently.
    for opset in model.opset_import:
        if opset.domain == "":
            opset.version = 14

    onnx.save(model, out / "model.onnx")
    (out / "tokenizer.json").write_text(json.dumps(tokenizer, ensure_ascii=False))
    (out / "tokenizer_config.json").write_text(json.dumps(config, ensure_ascii=False, indent=1))
    for name in ("model.onnx", "tokenizer.json", "tokenizer_config.json"):
        data = (out / name).read_bytes()
        print(f"{name}: {len(data)} bytes, sha256 {hashlib.sha256(data).hexdigest()}")


if __name__ == "__main__":
    main(Path(sys.argv[1] if len(sys.argv) > 1 else "dist/local-model"))
