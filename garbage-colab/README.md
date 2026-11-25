# 垃圾分类：Colab GPU 一键运行

[![Open In Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/greatzhu-cyber/fuck-ddl/blob/master/garbage-colab/garbage_colab_gpu.ipynb)

点击上方按钮打开 Notebook，再点 **全部运行**。数据、代码和权重会自动下载，无需手动上传 ZIP 或填写 GitHub Token。
如果提示没有 GPU，选择 **代码执行程序 → 更改运行时类型 → GPU**，然后重新全部运行。
训练结束后自动下载结果包；结果包内有模型、预测文件和训练日志，不会自动提交学校作业。

从上一版验证集 **123/130（94.62%）** 的 MobileNetV2 权重继续微调。使用原 26 类标签与 130 张验证图，并排除训练集中三份与验证集重复的图片，实际训练 2340 张原图。
默认解冻后半部分、最多 25 轮、AMP 混合精度；保留训练前基线，按验证正确数及交叉熵选择最终权重。
GPU 训练结果以实际运行输出为准，Notebook 不预填新成绩。

权重转换已经在全部 130 张验证图上核对，预测零差异。也完成了 CPU 小规模训练、冻结参数、保存/加载及导出的流程检查；这些不是 GPU 微调成绩。
验证集参与模型选择，不能等同学校隐藏测试成绩。MindSpore 导出仍需平台测试。

`assets/` 保存自动下载所需资源分片，Notebook 会自动合并和 SHA-256 校验，无需手动操作。
课程图片及预训练资源沿用其原来源的使用条件，本目录未重新授权这些数据。
