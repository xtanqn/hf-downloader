/*
 * ComfyUI 目录映射
 *
 * 用户把下载目录设为 ComfyUI 的 models 文件夹（如 E:\models），
 * 选这个模式后按 HF 仓库内的目录名自动归类到 ComfyUI 标准子目录。
 *
 * 关于 unet 与 diffusion_models：
 *   2024 年中之后 ComfyUI 把 unet\ 改名为 diffusion_models\，两个目录都还能被加载，
 *   但官方推荐、社区实际在用的是 diffusion_models\。
 *   HF 上的 diffusers 仓库（SDXL / FLUX / SD3 等）目录名仍叫 unet\，
 *   所以这里把 unet\ 默认映射到 diffusion_models\。
 *
 *   如果用户的 ComfyUI 是旧版（只有 unet\），可以在设置里改偏好（见 settings.legacyUnetDir）。
 *
 * 映射不到的文件：
 *   - 仓库根目录的单文件（如 sd_xl_base_1.0.safetensors，是完整模型）
 *     → checkpoints\
 *   - text_encoder / tokenizer / scheduler 这类 diffusers 组件
 *     → 不猜，放 {dest}\_其他\{原路径}，用户自己看着办
 */
'use strict';

/* HF 目录（含别名）→ ComfyUI 子目录 */
const MAP = {
  vae: 'vae',
  vae_decoder: 'vae',
  vae_encoder: 'vae',

  /* 新版 ComfyUI 的扩散模型目录（旧名 unet） */
  unet: 'diffusion_models',
  unet2: 'diffusion_models',
  diffusion_models: 'diffusion_models',
  unet_gguf: 'unet_gguf',

  lora: 'loras',
  loras: 'loras',

  controlnet: 'controlnet',
  control_nets: 'controlnet',

  clip: 'clip',
  text_encoder: 'text_encoders',
  text_encoders: 'text_encoders',
  clip_vision: 'clip_vision',
  ipadapter: 'ipadapter',
  ipadapter_pulid: 'ipadapter',

  upscale_models: 'upscale_models',
  upscale: 'upscale_models',
  esrgan: 'upscale_models',
  latent_upscale_models: 'latent_upscale_models',

  embeddings: 'embeddings',
  hypernetworks: 'hypernetworks',
  style_models: 'style_models',
  model_patches: 'model_patches',
  vae_approx: 'vae_approx',
  gligen: 'gligen',
  gguf: 'gguf',

  instantid: 'instantid',
  photomaker: 'photomaker',
  pulid: 'pulid',
  sams: 'sams',
  sam2: 'sam2',
  reactor: 'reactor',
  insightface: 'insightface',
  facerestore_models: 'facerestore_models',
  facedetection: 'facedetection',
  face_parsing: 'face_parsing',

  animatediff_models: 'animatediff_models',
  animatediff_motion_lora: 'animatediff_motion_lora',
  animatediff_video_formats: 'animatediff_video_formats',

  llm: 'LLM',
  audio_encoders: 'audio_encoders',
  faster_whisper: 'faster-whisper',
  onnx: 'onnx',
  detection: 'detection',
  segmentation: 'segmentation',
  yolo: 'yolo',
  ultralytics: 'ultralytics',
  diffusers: 'diffusers',
  transformers: 'transformers',
  configs: 'configs',
};

/* 仓库根目录单文件 → 按扩展名归类 */
const EXT_MAP = {
  '.safetensors': 'checkpoints',
  '.ckpt': 'checkpoints',
  '.pt': 'checkpoints',
  '.pth': 'checkpoints',
  '.sft': 'checkpoints',
  '.gguf': 'gguf',
};

/**
 * 计算一个仓库内路径在 ComfyUI 模式下的本地相对路径。
 * 返回相对于下载根目录（models\）的路径；无法归类返回 null。
 *
 * @param {string} hfPath  仓库内路径，如 'vae/model.safetensors'
 * @param {object} [opts]  { legacyUnetDir: true } 旧版 ComfyUI，unet 落到 unet\
 */
function comfyRelPath(hfPath, opts) {
  const o = opts || {};
  const segs = String(hfPath).split('/');

  if (segs.length === 1) {
    const dot = segs[0].lastIndexOf('.');
    const ext = dot >= 0 ? segs[0].slice(dot).toLowerCase() : '';
    const dest = EXT_MAP[ext];
    return dest ? dest + '\\' + segs[0] : null;
  }

  const top = segs[0].toLowerCase();
  let dest = MAP[top];

  if (!dest) {
    // diffusers 组件（tokenizer / scheduler / feature_extractor 等）→ _其他\ 保留原结构
    return '_其他\\' + segs.join('\\');
  }

  // 旧版 ComfyUI 兼容：unet 系列落回 unet\
  if (o.legacyUnetDir && (top === 'unet' || top === 'unet2')) {
    dest = 'unet';
  }

  return dest + '\\' + segs.slice(1).join('\\');
}

module.exports = { comfyRelPath, MAP, EXT_MAP };
