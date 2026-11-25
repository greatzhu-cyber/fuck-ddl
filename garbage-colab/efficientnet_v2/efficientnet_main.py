"""School prediction API: RGB HWC array -> one required English class name."""
from pathlib import Path
import torch
from efficientnet_model import LABELS,preprocess,load_efficientnet

_ROOT=Path(__file__).resolve().parent
_model=None


def predict(image):
    global _model
    if _model is None:
        _model=load_efficientnet(_ROOT/'results/efficientnet_v2/best.pt','cpu')
    with torch.inference_mode():
        output=_model(preprocess(image).unsqueeze(0))
    return LABELS[int(output.argmax(1).item())]
