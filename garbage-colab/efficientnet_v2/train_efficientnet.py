"""Five head epochs + 25 full fine-tuning epochs, with per-epoch predictions."""
import argparse
import csv
import json
import math
import random
import shutil
import time
import zipfile
from pathlib import Path
import numpy as np
import torch
from torch import nn
from torch.utils.data import DataLoader
from gpu_model import LABELS,load_model
from efficientnet_model import make_efficientnet,load_efficientnet
from train_colab_gpu import audit_dataset,make_loader,evaluate,cpu_state,Images,DATA

ROOT=Path(__file__).resolve().parent
SEED=20261110


def write_json(path,value):
    Path(path).write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding='utf-8')


def predictions(path,rows,logits,labels):
    pred=logits.argmax(1)
    with Path(path).open('w',newline='',encoding='utf-8') as f:
        writer=csv.writer(f)
        writer.writerow(['path','true_label','pred_label','correct'])
        for (image,y),p in zip(rows,pred):
            writer.writerow([str(image.relative_to(DATA)),LABELS[y],LABELS[int(p)],int(y==p)])


def save_model(path,model,epoch,phase,metrics,args):
    torch.save({'architecture':'efficientnet_b0','state_dict':cpu_state(model),
                'labels':LABELS,'epoch':epoch,'phase':phase,'validation':metrics,
                'config':vars(args),'seed':SEED},path)


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--output',required=True)
    parser.add_argument('--device',choices=['cuda','cpu'],default='cuda')
    parser.add_argument('--head-epochs',type=int,default=5)
    parser.add_argument('--finetune-epochs',type=int,default=25)
    parser.add_argument('--batch-size',type=int,default=32)
    parser.add_argument('--workers',type=int,default=2)
    parser.add_argument('--head-warmup-lr',type=float,default=1e-3)
    parser.add_argument('--backbone-lr',type=float,default=1e-5)
    parser.add_argument('--head-lr',type=float,default=1e-4)
    parser.add_argument('--weight-decay',type=float,default=1e-4)
    parser.add_argument('--no-amp',action='store_true')
    parser.add_argument('--smoke-test',action='store_true')
    args=parser.parse_args()
    if args.device=='cuda' and not torch.cuda.is_available():
        raise RuntimeError('No CUDA GPU. Select a GPU runtime in Colab.')
    if args.device=='cpu' and not args.smoke_test:
        raise ValueError('CPU mode is only for the explicit local smoke test.')
    if min(args.head_epochs,args.finetune_epochs,args.batch_size)<1:
        raise ValueError('Epochs and batch size must be positive.')
    out=Path(args.output).resolve();out.mkdir(parents=True,exist_ok=True)
    if (out/'efficientnet_best.pt').exists():
        raise FileExistsError('Choose a fresh output directory; an earlier run is present.')
    (out/'epoch_predictions').mkdir(exist_ok=True)
    random.seed(SEED);np.random.seed(SEED);torch.manual_seed(SEED);torch.set_num_threads(4)
    torch.hub.set_dir(str(ROOT/'official_model_cache'))
    device=torch.device(args.device)
    if device.type=='cuda':
        torch.cuda.manual_seed_all(SEED)
        torch.backends.cuda.matmul.allow_tf32=False
        torch.backends.cudnn.allow_tf32=False
        torch.backends.cudnn.benchmark=False
    amp=device.type=='cuda' and not args.no_amp
    start=time.monotonic()
    train_rows,val_rows,removed=audit_dataset()
    train_loader=make_loader(train_rows,True,args,device)
    val_loader=make_loader(val_rows,False,args,device)
    baseline=load_model(ROOT/'gpu_assets/baseline.pt',device)
    base_metrics,base_logits,labels=evaluate(baseline,val_loader,device)
    reference=np.load(ROOT/'gpu_assets/reference_val_logits.npy')
    assert base_metrics['correct']==123 and not (base_logits.argmax(1)!=reference.argmax(1)).any()
    predictions(out/'mobilenet_baseline_predictions.csv',val_rows,base_logits,labels)
    print(f"MobileNet reference verified: {base_metrics['correct']}/130 = {base_metrics['accuracy']:.2%}",flush=True)
    del baseline
    print('Loading official EfficientNet-B0 ImageNet weights (first run downloads about 21 MB).',flush=True)
    model=make_efficientnet(pretrained=True).to(device)
    initial,initial_logits,_=evaluate(model,val_loader,device)
    predictions(out/'epoch_predictions/epoch_000_initial.csv',val_rows,initial_logits,labels)
    best_metrics,best_key,best_epoch=initial,(initial['accuracy'],-initial['loss']),0
    save_model(out/'efficientnet_best.pt',model,0,'initial',initial,args)
    criterion=nn.CrossEntropyLoss(label_smoothing=0.0)
    scaler=torch.amp.GradScaler('cuda',enabled=amp)
    original_stem=model.features[0][0].weight.detach().cpu().clone()
    original_head=model.classifier[1].weight.detach().cpu().clone()
    original_bn={k:v.detach().cpu().clone() for k,v in model.state_dict().items()
                 if k.endswith(('running_mean','running_var'))}
    history=[];global_epoch=0;checks={}
    phases=[('head',args.head_epochs),('finetune',args.finetune_epochs)]
    for phase,epochs in phases:
        for parameter in model.parameters():parameter.requires_grad=phase=='finetune'
        for parameter in model.classifier.parameters():parameter.requires_grad=True
        if phase=='head':
            optimizer=torch.optim.AdamW(model.classifier.parameters(),lr=args.head_warmup_lr,
                                       weight_decay=args.weight_decay)
            scheduler=None
        else:
            optimizer=torch.optim.AdamW([{'params':model.features.parameters(),'lr':args.backbone_lr},
                                         {'params':model.classifier.parameters(),'lr':args.head_lr}],
                                        weight_decay=args.weight_decay)
            scheduler=torch.optim.lr_scheduler.LambdaLR(optimizer,
                         lambda e:0.1+0.9*0.5*(1+math.cos(math.pi*e/epochs)))
        print(f'Phase={phase}, trainable parameters={sum(p.numel() for p in model.parameters() if p.requires_grad):,}',flush=True)
        for phase_epoch in range(1,epochs+1):
            global_epoch+=1
            model.train()
            if phase=='head':model.features.eval()
            for module in model.modules():
                if isinstance(module,nn.modules.batchnorm._BatchNorm):module.eval()
            seen=correct=0;loss_sum=0.0
            for i,(images,target) in enumerate(train_loader):
                if args.smoke_test and i>=2:break
                images=images.to(device,non_blocking=True);target=target.to(device,non_blocking=True)
                optimizer.zero_grad(set_to_none=True)
                with torch.autocast(device_type=device.type,dtype=torch.float16,enabled=amp):
                    logits=model(images);loss=criterion(logits,target)
                if not torch.isfinite(loss):raise RuntimeError('Non-finite training loss.')
                scaler.scale(loss).backward();scaler.unscale_(optimizer)
                nn.utils.clip_grad_norm_([p for p in model.parameters() if p.requires_grad],5.0)
                scaler.step(optimizer);scaler.update()
                seen+=len(target);correct+=int((logits.detach().argmax(1)==target).sum())
                loss_sum+=float(loss.detach())*len(target)
            metrics,logits,_=evaluate(model,val_loader,device)
            predictions(out/f'epoch_predictions/epoch_{global_epoch:03d}_{phase}.csv',val_rows,logits,labels)
            key=(metrics['accuracy'],-metrics['loss'])
            if key>best_key:
                best_key,best_metrics,best_epoch=key,metrics,global_epoch
                save_model(out/'efficientnet_best.pt',model,global_epoch,phase,metrics,args)
            save_model(out/'efficientnet_last.pt',model,global_epoch,phase,metrics,args)
            row=dict(epoch=global_epoch,phase=phase,phase_epoch=phase_epoch,
                     train_seen=seen,train_loss=loss_sum/seen,train_accuracy=correct/seen,
                     val_loss=metrics['loss'],val_accuracy=metrics['accuracy'],val_correct=metrics['correct'],
                     learning_rates=[g['lr'] for g in optimizer.param_groups],best_epoch=best_epoch)
            history.append(row);write_json(out/'history.json',history)
            print(f"Epoch {global_epoch:02d} [{phase} {phase_epoch}/{epochs}]: train_loss={row['train_loss']:.4f}, "
                  f"train_acc={row['train_accuracy']:.2%}, val={metrics['correct']}/130 ({metrics['accuracy']:.2%}), "
                  f"EfficientNet best={best_metrics['accuracy']:.2%}; MobileNet reference={base_metrics['accuracy']:.2%}",flush=True)
            if scheduler:scheduler.step()
            if args.smoke_test:break
        if phase=='head':
            checks['warmup_stem_frozen']=torch.equal(original_stem,model.features[0][0].weight.detach().cpu())
            checks['warmup_head_updated']=not torch.equal(original_head,model.classifier[1].weight.detach().cpu())
            checks['finetune_stem_before']=model.features[0][0].weight.detach().cpu().clone()
    checks['finetune_stem_updated']=not torch.equal(checks.pop('finetune_stem_before'),model.features[0][0].weight.detach().cpu())
    checks['batchnorm_statistics_frozen']=all(torch.equal(v,model.state_dict()[k].detach().cpu()) for k,v in original_bn.items())
    if not all(checks.values()):raise RuntimeError(f'Training state checks failed: {checks}')
    last_metrics,last_logits,_=evaluate(model,val_loader,device)
    predictions(out/'efficientnet_last_predictions.csv',val_rows,last_logits,labels)
    del model
    best=load_efficientnet(out/'efficientnet_best.pt',device)
    final,final_logits,_=evaluate(best,val_loader,device)
    predictions(out/'efficientnet_best_predictions.csv',val_rows,final_logits,labels)
    assert final['correct']==best_metrics['correct']
    reloaded=load_efficientnet(out/'efficientnet_best.pt','cpu')
    cpu_loader=DataLoader(Images(val_rows),batch_size=8,shuffle=False,num_workers=0)
    cpu_metrics,cpu_logits,_=evaluate(reloaded,cpu_loader,torch.device('cpu'))
    mismatch=int((cpu_logits.argmax(1)!=final_logits.argmax(1)).sum())
    if mismatch:raise RuntimeError(f'Saved CPU checkpoint mismatch on {mismatch} images.')
    base_pred=base_logits.argmax(1);best_pred=final_logits.argmax(1);last_pred=last_logits.argmax(1)
    with (out/'changes_vs_baseline.csv').open('w',newline='',encoding='utf-8') as f:
        w=csv.writer(f);w.writerow(['path','true_label','baseline_pred','efficientnet_best_pred','efficientnet_last_pred','fixed_old_error','new_error'])
        for (path,y),b,p,l in zip(val_rows,base_pred,best_pred,last_pred):
            w.writerow([str(path.relative_to(DATA)),LABELS[y],LABELS[int(b)],LABELS[int(p)],LABELS[int(l)],int(b!=y and p==y),int(b==y and p!=y)])
    recommend_eff=(final['accuracy'],-final['loss'])>(base_metrics['accuracy'],-base_metrics['loss'])
    with zipfile.ZipFile(out/'recommended_submission.zip','w',zipfile.ZIP_DEFLATED) as z:
        z.write(ROOT/'gpu_model.py','gpu_model.py')
        if recommend_eff:
            z.write(ROOT/'efficientnet_main.py','main.py');z.write(ROOT/'efficientnet_model.py','efficientnet_model.py')
            z.write(out/'efficientnet_best.pt','results/efficientnet_v2/best.pt')
        else:
            z.write(ROOT/'torch_main.py','main.py');z.write(ROOT/'gpu_assets/baseline.pt','results/garbage_gpu/best.pt')
        z.writestr('requirements.txt','torch>=2.3\ntorchvision>=0.18\nnumpy\nPillow\n')
    confusion=np.zeros((26,26),dtype=int);np.add.at(confusion,(labels,best_pred),1)
    summary=dict(architecture='efficientnet_b0',pretrained='torchvision ImageNet1K_V1',
                 device=str(device),device_name=torch.cuda.get_device_name() if device.type=='cuda' else 'CPU',
                 torch_version=torch.__version__,seed=SEED,config=vars(args),smoke_test=args.smoke_test,
                 training_images=len(train_rows),validation_images=len(val_rows),removed_training_duplicates=removed,
                 mobilenet_baseline=base_metrics,efficientnet_initial=initial,efficientnet_best=final,
                 efficientnet_last=last_metrics,best_epoch=best_epoch,completed_epochs=len(history),
                 recommended_model='efficientnet_b0' if recommend_eff else 'mobilenet_v2_baseline',
                 fixed_baseline_errors=int(((base_pred!=labels)&(best_pred==labels)).sum()),
                 introduced_new_errors=int(((base_pred==labels)&(best_pred!=labels)).sum()),
                 training_state_checks=checks,saved_cpu_check=dict(passed=mismatch==0,prediction_mismatches=mismatch),
                 confusion_matrix=confusion.tolist(),amp=amp,elapsed_seconds=time.monotonic()-start,
                 validation_usage='The same validation set selects checkpoints; this is not a hidden test result.')
    write_json(out/'metrics.json',summary)
    report=(f"# EfficientNet-B0 second experiment\n\nBaseline: {base_metrics['correct']}/130 ({base_metrics['accuracy']:.2%}).\n\n"
            f"EfficientNet best: {final['correct']}/130 ({final['accuracy']:.2%}), epoch {best_epoch}.\n\n"
            f"Recommended model: {summary['recommended_model']}.\n\n"
            f"Fixed old errors: {summary['fixed_baseline_errors']}; new errors: {summary['introduced_new_errors']}.\n\n"
            f"Smoke test only: {args.smoke_test}.\n\n"
            "Every epoch's predictions and the last checkpoint are included. The same validation set selects checkpoints. "
            "The PyTorch submission requires school-platform testing; no MindSpore conversion is claimed.\n")
    (out/'RESULTS.md').write_text(report,encoding='utf-8')
    with zipfile.ZipFile(out/'efficientnet_v2_results.zip','w',zipfile.ZIP_DEFLATED) as z:
        for name in ['recommended_submission.zip','efficientnet_last.pt','metrics.json','history.json','RESULTS.md',
                     'mobilenet_baseline_predictions.csv','efficientnet_best_predictions.csv',
                     'efficientnet_last_predictions.csv','changes_vs_baseline.csv']:
            z.write(out/name,name)
        if not recommend_eff:z.write(out/'efficientnet_best.pt','efficientnet_best.pt')
        for p in sorted((out/'epoch_predictions').glob('*.csv')):z.write(p,'epoch_predictions/'+p.name)
    print(json.dumps({k:v for k,v in summary.items() if k!='confusion_matrix'},ensure_ascii=False,indent=2),flush=True)
    print('Results:',out/'efficientnet_v2_results.zip',flush=True)


if __name__=='__main__':main()
