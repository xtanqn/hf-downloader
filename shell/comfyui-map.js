/*
 * ComfyUI 目录映射
 *
 * 用户把下载目录设为 ComfyUI 的 models 文件夹（如 E:\ComfyUI\models），
 * 选这个模式后按 HF 仓库内的目录名自动归类到 ComfyUI 标准子目录：
 *
 *   vae/*            →  {dest}\vae\*
 *   unet/*           →  {dest}\unet\*          （新 ComfyUI 也叫 diffusion_models）
 *   lora /loras/*    →  {dest}\loras\*
 *   controlnet/*     →  {dest}\controlnet\*
 *   ...其余见 MAP
 *
 * 映射不到的文件：
 *   - 仓库根目录的单文件（如 sd_xl_base_1.0.safetensors，是完整模型）
 *     → checkpoints\（除非扩展名表明是别的类型）
 *   - text_encoder / tokenizer / scheduler 这类 diffusers 组件
 *     → 不猜，放 {dest}\_其他\{原路径}，用户自己看着办
 */
'use strict';

/* HF 目录（含别名）→ ComfyUI 子目录 */
const MAP = {
  vae: 'vae',
  vae_decoder: 'vae',
  vae_encoder: 'vae',

  unet: 'unet',
  diffusion_models: 'diffusion_models',
  unet2: 'unet',

  lora: 'loras',
  loras: 'loras',

  controlnet: 'controlnet',
  control_nets: 'controlnet',

  clip: 'clip',
  text_encoders: 'clip',
  clip_vision: 'clip_vision',
  ipadapter: 'ipadapter',
  ipadapter_pulid: 'ipadapter',

  upscale_models: 'upscale_models',
  upscale: 'upscale_models',
  esrgan: 'upscale_models',

  embeddings: 'embeddings',
  hypernetworks: 'hypernetworks',
  style_models: 'style_models',
  samplers: 'sae',
  instantid: 'instantid',
  photomaker: 'photomaker',
  sams: 'sams',
  reactors: 'reactors',
  animatediff_models: 'animatediff_models',
  animatediff_motion_lora: 'animatediff_motion_lora',
  animatediff_video_formats: 'animatediff_video_formats',
  llm: 'llm',
  segmented: 'segmented',
  tensorrt: 'tensorrt',
  vae_approx: 'vae_approx',
  model_patches: 'model_patches',
};

/* 仓库根目录单文件 → 按扩展名归类 */
const EXT_MAP = {
  '.safetensors': 'checkpoints',
  '.ckpt': 'checkpoints',
  '.pt': 'checkpoints',
  '.pth': 'checkpoints',
  '.sft': 'checkpoints',
};

/**
 * 计算一个仓库内路径在 ComfyUI 模式下的本地相对路径。
 * 返回相对于下载根目录（models\）的路径，分段用 '\' 连接；无法归类返回 null。
 */
function comfyRelPath(hfPath) {
  const segs = String(hfPath).split('/');
  if (segs.length === 1) {
    // 仓库根目录的单文件 → 按扩展名，归不进就 null
    const dot = segs[0].lastIndexOf('.');
    const ext = dot >= 0 ? segs[0].slice(dot).toLowerCase() : '';
    const dest = EXT_MAP[ext];
    return dest ? `${dest}\\${segs[0]}` : null;
  }
  const top = segs[0].toLowerCase();
  const dest = MAP[top];
  if (dest) return `${dest}\\${segs.slice(1).join('\\')}`;
  // diffusers 组件（text_encoder/tokenizer/scheduler 等）→ _其他\ 保留原结构
  return `_其他\\${segs.join('\\')}`;
}

module.exports = { comfyRelPath, MAP, EXT_MAP };
