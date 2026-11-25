"""EfficientNet-B0 model and CPU prediction with the course's exact label order."""
import torch
from torch import nn
from torchvision.models import efficientnet_b0, EfficientNet_B0_Weights
from gpu_model import LABELS, preprocess


def make_efficientnet(pretrained=False):
    weights=EfficientNet_B0_Weights.IMAGENET1K_V1 if pretrained else None
    model=efficientnet_b0(weights=weights)
    model.classifier[1]=nn.Linear(model.classifier[1].in_features,len(LABELS))
    return model


def load_efficientnet(path,device='cpu'):
    checkpoint=torch.load(path,map_location='cpu',weights_only=True)
    if checkpoint.get('architecture')!='efficientnet_b0' or checkpoint['labels']!=LABELS:
        raise ValueError('Unexpected model architecture or label order')
    model=make_efficientnet(pretrained=False)
    model.load_state_dict(checkpoint['state_dict'],strict=True)
    return model.to(device).eval()
