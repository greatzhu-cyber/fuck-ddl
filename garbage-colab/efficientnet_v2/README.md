# EfficientNet-B0：第二版 Colab GPU 训练

[![Open In Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/greatzhu-cyber/fuck-ddl/blob/master/garbage-colab/efficientnet_v2/efficientnet_b0_colab.ipynb)

打开后选择 GPU，点 **全部运行**。自动下载原始数据与基线资源，以及 Torchvision 官方 EfficientNet-B0 ImageNet1K_V1 权重；不用上传文件或填写 Token。

- 使用原包的 2340 张训练图及 130 张验证图，继续排除三份跨训练/验证重复图片，不添加外部标注图片。
- EfficientNet-B0 从官方 ImageNet 预训练权重开始，重新训练 26 类分类头；不把 MobileNet 的参数装进新网络。
- 分类头预热 5 轮，然后整网微调完整 25 轮，不使用第 8 轮早停。
- AdamW；预热 head LR=1e-3，微调 backbone LR=1e-5、head LR=1e-4，weight decay=1e-4，余弦下降，label smoothing=0。
- BN 运行统计固定，AMP FP16；验证与预测均固定 RGB/224×224/ImageNet 归一化，与基线保持相同输入视野。
- 这是新训练方案与旧方案的比较，不是只改变一个变量的网络消融实验，效果需实际运行后判断。
- 逐轮保存预测、历史及最近权重。结果 ZIP 包含最后一轮权重；最佳候选若不是推荐模型，也单独包含，以免丢失诊断材料。
- 推荐模型按验证正确数优先、相同正确数时交叉熵最低选择。原 94.62% MobileNet 基线保留；新模型不更好时继续推荐原模型。
- 不预填 GPU 训练成绩。CPU 小规模流程检查不等于在用户 GPU 上完整训练。
- 推荐提交包使用 PyTorch，predict(image) 输入输出与 26 类英文名称不变，需要学校平台测试；不声称已有 EfficientNet 的 MindSpore 导出。

资源复用上一版在 GitHub 已发布的固定提交，不重复上传图片。原 MobileNet Notebook 保持不变。
