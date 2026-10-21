import { useState, useEffect, useRef } from 'react';
import { useTheme } from '../theme/ThemeContext.jsx';
import Sidebar from '../shared/Sidebar.jsx';
import ThemeToggle from '../shared/ThemeToggle.jsx';
import AvatarMenu from '../shared/Avatar.jsx';
import Spinner from '../shared/Spinner.jsx';
import { part1, imageService } from '../api.js';
import {
  IconVideo, IconImage, IconEye, IconDownload, IconSparkles, IconEdit, IconCopy,
} from '../icons/index.jsx';

const DISPLAY_FONT = "'Sora', 'Inter', system-ui, sans-serif";

// Real style keys from the Image Generation Service's STYLE_PRESETS -- must
// match exactly, they are sent straight through as the `style` param.
const PHOTO_STYLES = ['none', 'photorealistic', 'anime', 'oil_painting', 'watercolor', 'cyberpunk', 'sketch', 'pixel_art'];
const STYLE_LABELS = { none: 'None', photorealistic: 'Photoreal', anime: 'Anime', oil_painting: 'Oil paint', watercolor: 'Watercolor', cyberpunk: 'Cyberpunk', sketch: 'Sketch', pixel_art: 'Pixel art' };
const ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3'];
// 'auto' = don't send a ratio override; the backend derives it from the
// uploaded image via _fit_to_nearest_bucket.
const IMG2IMG_RATIO_OPTIONS = ['auto', ...ASPECT_RATIOS];
const QUALITY_TO_STEPS = { SD: 20, HD: 40, '4K': 60 };

const PHOTO_MODES = [
  { id: 'text2img', label: 'Text to image' },
  { id: 'img2img', label: 'Image to image' },
];

// Mirrors the backend's accepted types / MAX_UPLOAD_BYTES (10MB) so bad files
// are rejected instantly instead of after an upload.
const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

// Real style keys from Part 1's steps/captions.py STYLES.
const CAPTION_STYLES = ['default', 'boxed', 'highlight'];

// Real voice IDs from Part 1's steps/voiceover.py VOICE_OPTIONS. `label` is
// display only; `id` is what the backend receives.
const VOICE_OPTIONS = [
  { id: 'en-US-AndrewNeural', label: 'Andrew (US)' },
  { id: 'en-US-JennyNeural', label: 'Jenny (US)' },
  { id: 'en-US-GuyNeural', label: 'Guy (US)' },
  { id: 'en-US-AriaNeural', label: 'Aria (US)' },
  { id: 'en-US-ChristopherNeural', label: 'Christopher (US)' },
  { id: 'en-US-MichelleNeural', label: 'Michelle (US)' },
  { id: 'en-GB-SoniaNeural', label: 'Sonia (UK)' },
  { id: 'en-GB-RyanNeural', label: 'Ryan (UK)' },
  { id: 'en-AU-NatashaNeural', label: 'Natasha (AU)' },
  { id: 'en-IN-NeerjaNeural', label: 'Neerja (IN)' },
  { id: 'en-IN-PrabhatNeural', label: 'Prabhat (IN)' },
];
const DEFAULT_VOICE = 'en-US-AndrewNeural';

// assembly.py renders every video at 1080x1920 (9:16).
const DEFAULT_VIDEO_ASPECT = '9/16';

const EXAMPLES = {
  video: ['3 tips to stay productive while working from home', '5 facts about the deep ocean'],
  text2img: ['A neon-lit forest with bioluminescent plants, photorealistic', 'A cozy reading nook in a rainy city, watercolor'],
  img2img: ['Turn this into a cyberpunk cityscape at night', 'Make this look like an oil painting'],
};

const STATUS_LABEL = { queued: 'In queue', processing: 'Generating', running: 'Generating', pending: 'In queue' };

function ratioLabelToCss(ratio) {
  return ratio === '1:1' ? '1/1' : ratio === '4:3' ? '4/3' : ratio === '9:16' ? '9/16' : '16/9';
}

function strengthLabel(strength) {
  if (strength < 0.4) return 'Light edit';
  if (strength < 0.7) return 'Moderate';
  return 'Heavy reinterpretation';
}

/* ---------------- small UI helpers ---------------- */

const focusRing = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6366F1]';

function OptionGroup({ label, options, value, onChange, t }) {
  return (
    <div>
      <span className="text-xs font-semibold block mb-2" style={{ color: t.fgMuted }}>{label}</span>
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={label}>
        {options.map((o) => {
          const active = value === o.id;
          return (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(o.id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${focusRing}`}
              style={{
                background: active ? 'linear-gradient(135deg, #6366F1, #8B5CF6)' : t.muted,
                color: active ? '#fff' : t.fgMuted,
                border: `1px solid ${active ? 'transparent' : t.border}`,
              }}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function EmptyState({ kind, t }) {
  const isVideo = kind === 'video';
  return (
    <div className="rounded-2xl flex flex-col items-center justify-center text-center px-8 py-16" style={{ border: `1.5px dashed ${t.border}`, background: t.card }}>
      <svg viewBox="0 0 200 120" className="w-48 mb-5" aria-hidden="true">
        <defs>
          <linearGradient id="gen-empty" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#6366F1" />
            <stop offset="1" stopColor="#8B5CF6" />
          </linearGradient>
        </defs>
        {isVideo ? (
          <>
            <rect x="74" y="6" width="52" height="92" rx="10" fill="url(#gen-empty)" opacity="0.9" />
            <rect x="80" y="12" width="40" height="80" rx="6" fill="rgba(255,255,255,0.22)" />
            <path d="M94 42v22l18-11z" fill="#fff" />
            <rect x="34" y="30" width="30" height="52" rx="7" fill={t.muted} stroke={t.border} transform="rotate(-8 49 56)" />
            <rect x="136" y="30" width="30" height="52" rx="7" fill={t.muted} stroke={t.border} transform="rotate(8 151 56)" />
          </>
        ) : (
          <>
            <rect x="52" y="14" width="96" height="72" rx="10" fill="url(#gen-empty)" opacity="0.9" />
            <circle cx="78" cy="38" r="8" fill="rgba(255,255,255,0.7)" />
            <path d="M52 76 L88 48 L114 68 L132 56 L148 70 V86 H52Z" fill="rgba(255,255,255,0.28)" />
            <rect x="30" y="64" width="38" height="30" rx="7" fill={t.muted} stroke={t.border} transform="rotate(-8 49 79)" />
          </>
        )}
      </svg>
      <h3 className="text-base font-bold mb-1" style={{ color: t.fg, fontFamily: DISPLAY_FONT }}>
        {isVideo ? 'Your videos will appear here' : 'Your images will appear here'}
      </h3>
      <p className="text-sm max-w-xs" style={{ color: t.fgMuted }}>
        {isVideo ? 'Describe an idea on the left and press Generate. A finished video usually takes a few minutes.' : 'Write a prompt on the left, pick a style and press Generate.'}
      </p>
    </div>
  );
}

function SkeletonGrid({ cols, ratio, t }) {
  return (
    <div className={`grid gap-4 ${cols}`}>
      {[0, 1, 2].map((i) => (
        <div key={i} className="rounded-2xl overflow-hidden animate-pulse" style={{ background: t.card, border: `1px solid ${t.border}` }}>
          <div style={{ aspectRatio: ratio, background: t.muted }} />
          <div className="p-3 space-y-2">
            <div className="h-2.5 rounded w-4/5" style={{ background: t.muted }} />
            <div className="h-2.5 rounded w-1/2" style={{ background: t.muted }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function ProgressOverlay({ status, dark }) {
  return (
    <div className="w-full h-full flex flex-col items-center justify-center gap-2 text-white" style={dark ? { background: 'rgba(0,0,0,0.45)' } : undefined}>
      <Spinner />
      <span className="text-xs font-medium">{STATUS_LABEL[status] || status || 'Generating'}...</span>
    </div>
  );
}

export default function GeneratorScreen({ onNavigate, onLogout, incomingPrompt }) {
  const { t } = useTheme();

  const [tab, setTab] = useState('video');
  const [prompt, setPrompt] = useState(incomingPrompt || '');
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState(null);
  const [loadingHistory, setLoadingHistory] = useState(true);

  const [videoResults, setVideoResults] = useState([]);
  const [photoResults, setPhotoResults] = useState([]);
  const [styleFilter, setStyleFilter] = useState('none');
  const [aspectRatio, setAspectRatio] = useState('16:9');
  const [quality, setQuality] = useState('HD');
  const [captionStyle, setCaptionStyle] = useState('default');
  const [voice, setVoice] = useState(DEFAULT_VOICE);

  // img2img state. img2imgRatio is deliberately separate from the txt2img
  // `aspectRatio` so switching modes doesn't cross-pollute the two flows.
  // 'auto' = no override (backend derives size from the uploaded image).
  const [photoMode, setPhotoMode] = useState('text2img');
  const [sourceImage, setSourceImage] = useState(null);
  const [strength, setStrength] = useState(0.6);
  const [img2imgRatio, setImg2imgRatio] = useState('auto');
  const fileInputRef = useRef(null);

  const [previewPhoto, setPreviewPhoto] = useState(null);
  // Which photo card (by id) is showing its source image via "Compare".
  const [compareId, setCompareId] = useState(null);

  // Reload past generations on mount. Video and photo jobs share one
  // Firestore collection (users/{uid}/jobs): video docs have `videoUrl`,
  // photo docs have `final_prompt` and no `videoUrl`. Photo docs don't
  // persist `style` or ratio yet, so reloaded cards fall back to defaults.
  // Finished photos need an authenticated blob fetch each (<img src> can't
  // attach the Firebase header). img2img source images are only fetched on
  // demand via "Compare".
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const jobs = await part1.listJobs();
        if (cancelled) return;

        const videoJobs = jobs.filter((job) => job.videoUrl);
        setVideoResults(
          videoJobs.map((job) => ({
            id: job.id || job.jobId,
            status: job.status,
            videoUrl: job.videoUrl,
            error: job.error,
            prompt: job.prompt || '',
            aspectRatio: DEFAULT_VIDEO_ASPECT,
          }))
        );

        const photoJobs = jobs.filter((job) => !job.videoUrl && job.final_prompt !== undefined);
        setPhotoResults(
          photoJobs.map((job) => ({
            id: job.id || job.jobId,
            status: job.status,
            prompt: job.final_prompt || '',
            style: job.style || 'none',
            mode: job.mode || 'text2img',
            error: job.error,
            aspectRatio: job.ratio || '16:9',
            naturalRatio: null,
            imageUrl: null,
            sourceUrl: null,
          }))
        );

        photoJobs
          .filter((job) => job.status === 'done')
          .forEach(async (job) => {
            const jobId = job.id || job.jobId;
            try {
              const url = await imageService.fetchImageBlobUrl(jobId);
              if (cancelled) return;
              setPhotoResults((prev) => prev.map((p) => (p.id === jobId ? { ...p, imageUrl: url } : p)));
            } catch (err) {
              console.error('Failed to load photo image:', err);
              if (cancelled) return;
              setPhotoResults((prev) =>
                prev.map((p) => (p.id === jobId ? { ...p, status: 'failed', error: err.message } : p))
              );
            }
          });
      } catch (err) {
        console.error('Failed to load generation history:', err);
      } finally {
        if (!cancelled) setLoadingHistory(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleGenerateVideo() {
    if (!prompt.trim()) return;
    setGenerating(true);
    setError(null);
    const placeholderId = `pending-${Date.now()}`;
    setVideoResults((prev) => [
      { id: placeholderId, status: 'processing', prompt, aspectRatio: DEFAULT_VIDEO_ASPECT },
      ...prev,
    ]);

    try {
      const { jobId } = await part1.generate(prompt, captionStyle, voice);
      const job = await part1.pollJob(jobId, (j) => {
        setVideoResults((prev) => prev.map((v) => (v.id === placeholderId ? { ...v, status: j.status } : v)));
      });

      setVideoResults((prev) =>
        prev.map((v) =>
          v.id === placeholderId
            ? { id: jobId, status: job.status, videoUrl: job.videoUrl, prompt, error: job.error, aspectRatio: v.aspectRatio }
            : v
        )
      );
      if (job.status === 'failed') setError(job.error || 'Video generation failed.');
    } catch (err) {
      setVideoResults((prev) => prev.map((v) => (v.id === placeholderId ? { ...v, status: 'failed', error: err.message } : v)));
      setError(err.message);
    } finally {
      setGenerating(false);
    }
  }

  // Corrects the card's guessed aspect ratio once the <video> reports its real size.
  function handleVideoMetadataLoaded(videoId, e) {
    const { videoWidth, videoHeight } = e.target;
    if (!videoWidth || !videoHeight) return;
    const ratio = `${videoWidth}/${videoHeight}`;
    setVideoResults((prev) =>
      prev.map((v) => (v.id === videoId && v.aspectRatio !== ratio ? { ...v, aspectRatio: ratio } : v))
    );
  }

  // Same idea for photos. Skipped while a card shows its source via "Compare"
  // so the source's ratio doesn't overwrite the result's naturalRatio.
  function handlePhotoImageLoaded(photoId, e) {
    if (compareId === photoId) return;
    const { naturalWidth, naturalHeight } = e.target;
    if (!naturalWidth || !naturalHeight) return;
    const ratio = `${naturalWidth}/${naturalHeight}`;
    setPhotoResults((prev) =>
      prev.map((p) => (p.id === photoId && p.naturalRatio !== ratio ? { ...p, naturalRatio: ratio } : p))
    );
  }

  // Validates and stores the file picked for img2img (client-side mirror of
  // the backend checks) and reads its natural size for the placeholder card.
  function handleSourceImageSelect(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);

    if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
      setError('Please upload a PNG, JPEG, or WEBP image.');
      e.target.value = '';
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setError(`Image is too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Max size is 10MB.`);
      e.target.value = '';
      return;
    }

    if (sourceImage?.previewUrl) URL.revokeObjectURL(sourceImage.previewUrl);
    const previewUrl = URL.createObjectURL(file);
    const probe = new window.Image();
    probe.onload = () => {
      setSourceImage({ file, previewUrl, aspectRatio: `${probe.naturalWidth}/${probe.naturalHeight}` });
    };
    probe.src = previewUrl;
  }

  function clearSourceImage() {
    if (sourceImage?.previewUrl) URL.revokeObjectURL(sourceImage.previewUrl);
    setSourceImage(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  // Fetches an img2img job's original source on demand, then toggles the
  // card between source and result.
  async function handleToggleCompare(photo) {
    if (compareId === photo.id) {
      setCompareId(null);
      return;
    }
    if (!photo.sourceUrl) {
      try {
        const url = await imageService.fetchSourceImageBlobUrl(photo.id);
        setPhotoResults((prev) => prev.map((p) => (p.id === photo.id ? { ...p, sourceUrl: url } : p)));
      } catch (err) {
        console.error('Failed to load source image:', err);
        setError('Could not load the original source image for this job.');
        return;
      }
    }
    setCompareId(photo.id);
  }

  async function handleGenerateTextToImage() {
    if (!prompt.trim()) return;
    setGenerating(true);
    setError(null);
    const placeholderId = `pending-${Date.now()}`;
    // Ratio is stored on the item itself so older cards don't reflow when
    // the picker changes later.
    setPhotoResults((prev) => [
      { id: placeholderId, status: 'queued', prompt, style: styleFilter, mode: 'text2img', aspectRatio: aspectRatio, naturalRatio: null },
      ...prev,
    ]);

    try {
      const { job_id: jobId } = await imageService.generate({
        prompt,
        style: styleFilter,
        ratio: aspectRatio,
        num_inference_steps: QUALITY_TO_STEPS[quality],
      });

      const job = await imageService.pollJob(jobId, (j) => {
        setPhotoResults((prev) => prev.map((p) => (p.id === placeholderId ? { ...p, status: j.status } : p)));
      });

      // /download/{job_id} needs the Firebase auth header, so fetch once
      // here and hand the DOM a blob: URL (see api.js fetchImageBlobUrl).
      let imageUrl = null;
      if (job.status === 'done') {
        try {
          imageUrl = await imageService.fetchImageBlobUrl(jobId);
        } catch (err) {
          setPhotoResults((prev) =>
            prev.map((p) => (p.id === placeholderId ? { ...p, status: 'failed', error: err.message } : p))
          );
          setError(err.message);
          return;
        }
      }

      setPhotoResults((prev) =>
        prev.map((p) =>
          p.id === placeholderId
            ? { id: jobId, status: job.status, prompt, style: styleFilter, mode: 'text2img', error: job.error, aspectRatio: p.aspectRatio, naturalRatio: null, imageUrl }
            : p
        )
      );
      if (job.status === 'failed') setError(job.error || 'Image generation failed.');
    } catch (err) {
      setPhotoResults((prev) => prev.map((p) => (p.id === placeholderId ? { ...p, status: 'failed', error: err.message } : p)));
      setError(err.message);
    } finally {
      setGenerating(false);
    }
  }

  async function handleGenerateImageToImage() {
    if (!prompt.trim() || !sourceImage) return;
    setGenerating(true);
    setError(null);
    const placeholderId = `pending-${Date.now()}`;

    // Explicit ratio wins; otherwise fall back to the source image's own ratio.
    const effectiveRatio = img2imgRatio !== 'auto' ? img2imgRatio : sourceImage.aspectRatio;

    // The placeholder shows the uploaded source right away (local blob preview).
    setPhotoResults((prev) => [
      {
        id: placeholderId,
        status: 'queued',
        prompt,
        style: styleFilter,
        mode: 'img2img',
        aspectRatio: effectiveRatio,
        naturalRatio: null,
        sourceUrl: sourceImage.previewUrl,
      },
      ...prev,
    ]);

    try {
      // /img2img is multipart/form-data: image bytes plus the same fields as /generate.
      const formData = new FormData();
      formData.append('image', sourceImage.file);
      formData.append('prompt', prompt);
      formData.append('style', styleFilter);
      formData.append('strength', String(strength));
      formData.append('num_inference_steps', String(QUALITY_TO_STEPS[quality]));
      // 'auto' = stay silent so the backend keeps using _fit_to_nearest_bucket.
      if (img2imgRatio !== 'auto') {
        formData.append('ratio', img2imgRatio);
      }

      const { job_id: jobId } = await imageService.img2img(formData);

      const job = await imageService.pollJob(jobId, (j) => {
        setPhotoResults((prev) => prev.map((p) => (p.id === placeholderId ? { ...p, status: j.status } : p)));
      });

      let imageUrl = null;
      if (job.status === 'done') {
        try {
          imageUrl = await imageService.fetchImageBlobUrl(jobId);
        } catch (err) {
          setPhotoResults((prev) =>
            prev.map((p) => (p.id === placeholderId ? { ...p, status: 'failed', error: err.message } : p))
          );
          setError(err.message);
          return;
        }
      }

      setPhotoResults((prev) =>
        prev.map((p) =>
          p.id === placeholderId
            ? {
                id: jobId,
                status: job.status,
                prompt,
                style: styleFilter,
                mode: 'img2img',
                error: job.error,
                aspectRatio: p.aspectRatio,
                naturalRatio: null,
                imageUrl,
                sourceUrl: p.sourceUrl, // keep the local preview
              }
            : p
        )
      );
      if (job.status === 'failed') setError(job.error || 'Image generation failed.');
    } catch (err) {
      setPhotoResults((prev) => prev.map((p) => (p.id === placeholderId ? { ...p, status: 'failed', error: err.message } : p)));
      setError(err.message);
    } finally {
      setGenerating(false);
      // Reset the picker. Deliberately does NOT revoke sourceImage.previewUrl:
      // the photoResults card now owns it (as sourceUrl).
      setSourceImage(null);
      setImg2imgRatio('auto');
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  // Frees blob: URLs. Call whenever a photo leaves photoResults (e.g. in a
  // delete-job handler) so blobs don't stay resident for the life of the tab.
  function revokePhotoUrl(photo) {
    if (photo?.imageUrl) URL.revokeObjectURL(photo.imageUrl);
    if (photo?.sourceUrl) URL.revokeObjectURL(photo.sourceUrl);
  }

  const handleGenerate = () => {
    if (tab === 'video') return handleGenerateVideo();
    return photoMode === 'img2img' ? handleGenerateImageToImage() : handleGenerateTextToImage();
  };

  const isImg2img = tab === 'photo' && photoMode === 'img2img';
  const generateDisabled = generating || !prompt.trim() || (isImg2img && !sourceImage);
  const exampleKey = tab === 'video' ? 'video' : photoMode;
  const placeholder =
    tab === 'video'
      ? 'Describe the video you want to create. For example: 3 tips to stay productive while working from home'
      : isImg2img
      ? 'Describe how to transform the uploaded image'
      : 'Describe the image you want to generate';

  const labelCls = 'text-xs font-semibold block mb-2';

  return (
    <div className="flex min-h-screen transition-colors duration-200" style={{ background: t.bg }}>
      <Sidebar screen="generator" onNavigate={onNavigate} onLogout={onLogout} />
      <div className="flex-1 flex flex-col min-w-0">
        <header
          className="flex items-center justify-between px-8 py-4 sticky top-0 z-10 transition-colors duration-200"
          style={{ background: t.headerBg, backdropFilter: 'blur(12px)', borderBottom: `1px solid ${t.border}` }}
        >
          <div>
            <h1 className="text-lg font-bold" style={{ color: t.fg, fontFamily: DISPLAY_FONT }}>AI Generator</h1>
            <p className="text-xs" style={{ color: t.fgSubtle }}>Describe your idea and let AI build it</p>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <AvatarMenu onNavigate={onNavigate} onLogout={onLogout} />
          </div>
        </header>

        <main className="flex-1 p-6 lg:p-8 grid grid-cols-1 xl:grid-cols-[420px_1fr] gap-8 items-start">
          {/* ---------- Composer ---------- */}
          <section aria-label="Create" className="xl:sticky xl:top-24 space-y-4">
            <div className="flex rounded-2xl p-1 gap-1" role="tablist" style={{ background: t.muted, border: `1px solid ${t.border}` }}>
              {[
                { id: 'video', label: 'Video', icon: <IconVideo size={16} /> },
                { id: 'photo', label: 'Photo', icon: <IconImage size={16} /> },
              ].map((tb) => (
                <button
                  key={tb.id}
                  role="tab"
                  aria-selected={tab === tb.id}
                  onClick={() => setTab(tb.id)}
                  className={`flex-1 flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold transition-all duration-150 ${focusRing}`}
                  style={{
                    background: tab === tb.id ? 'linear-gradient(135deg, #6366F1, #8B5CF6)' : 'transparent',
                    color: tab === tb.id ? '#FFFFFF' : t.fgMuted,
                    boxShadow: tab === tb.id ? '0 4px 12px rgba(99,102,241,0.3)' : 'none',
                  }}
                >
                  {tb.icon} {tb.label}
                </button>
              ))}
            </div>

            <div className="rounded-2xl p-5 space-y-5" style={{ background: t.card, border: `1px solid ${t.border}`, boxShadow: t.shadowSm }}>
              {tab === 'photo' && (
                <OptionGroup label="Mode" options={PHOTO_MODES} value={photoMode} onChange={setPhotoMode} t={t} />
              )}

              {isImg2img && (
                <div>
                  <span className={labelCls} style={{ color: t.fgMuted }}>Source image</span>
                  <input ref={fileInputRef} type="file" accept={ACCEPTED_IMAGE_TYPES.join(',')} onChange={handleSourceImageSelect} className="hidden" id="source-image-input" />
                  {sourceImage ? (
                    <div className="flex items-center gap-3 rounded-xl p-2.5" style={{ background: t.muted, border: `1px solid ${t.border}` }}>
                      <img src={sourceImage.previewUrl} alt="Source" className="w-14 h-14 rounded-lg object-cover shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-semibold truncate" style={{ color: t.fg }}>{sourceImage.file.name}</p>
                        <p className="text-xs" style={{ color: t.fgSubtle }}>{(sourceImage.file.size / 1024 / 1024).toFixed(1)} MB</p>
                      </div>
                      <button onClick={clearSourceImage} className={`text-xs font-semibold px-2.5 py-1 rounded-lg shrink-0 hover:opacity-80 ${focusRing}`} style={{ color: '#EF4444' }}>
                        Remove
                      </button>
                    </div>
                  ) : (
                    <label
                      htmlFor="source-image-input"
                      className="flex flex-col items-center gap-1.5 rounded-xl py-6 cursor-pointer text-center transition-all hover:opacity-80"
                      style={{ border: `1.5px dashed ${t.border}`, color: t.fgMuted }}
                    >
                      <IconImage size={20} />
                      <span className="text-xs font-semibold">Upload an image</span>
                      <span className="text-xs" style={{ color: t.fgSubtle }}>PNG, JPEG or WEBP, up to 10 MB</span>
                    </label>
                  )}
                </div>
              )}

              <div>
                <label htmlFor="gen-prompt" className={labelCls} style={{ color: t.fgMuted }}>Prompt</label>
                <textarea
                  id="gen-prompt"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder={placeholder}
                  rows={5}
                  maxLength={500}
                  className="w-full resize-none text-sm leading-relaxed rounded-xl p-3"
                  style={{ color: t.fg, background: t.muted, border: `1px solid ${t.border}` }}
                />
                <div className="flex items-start justify-between gap-3 mt-2">
                  <div className="flex flex-wrap gap-1.5">
                    {!prompt &&
                      EXAMPLES[exampleKey].map((ex) => (
                        <button
                          key={ex}
                          type="button"
                          onClick={() => setPrompt(ex)}
                          className={`text-xs font-medium px-2.5 py-1 rounded-full text-left hover:opacity-80 ${focusRing}`}
                          style={{ background: t.pillBg, color: t.pillFg, border: `1px solid ${t.pillBorder}` }}
                        >
                          {ex}
                        </button>
                      ))}
                  </div>
                  <span className="text-xs font-mono shrink-0" style={{ color: t.fgSubtle }}>{prompt.length}/500</span>
                </div>
              </div>

              {tab === 'video' && (
                <>
                  <OptionGroup label="Caption style" options={CAPTION_STYLES.map((s) => ({ id: s, label: s }))} value={captionStyle} onChange={setCaptionStyle} t={t} />
                  <div>
                    <label htmlFor="gen-voice" className={labelCls} style={{ color: t.fgMuted }}>Voice</label>
                    <select
                      id="gen-voice"
                      value={voice}
                      onChange={(e) => setVoice(e.target.value)}
                      className="w-full text-sm py-2 px-3 rounded-lg"
                      style={{ background: t.muted, color: t.fg, border: `1px solid ${t.border}` }}
                    >
                      {VOICE_OPTIONS.map((v) => (
                        <option key={v.id} value={v.id}>{v.label}</option>
                      ))}
                    </select>
                  </div>
                </>
              )}

              {tab === 'photo' && (
                <>
                  <OptionGroup
                    label="Aspect ratio"
                    options={(photoMode === 'text2img' ? ASPECT_RATIOS : IMG2IMG_RATIO_OPTIONS).map((r) => ({ id: r, label: r === 'auto' ? 'Match source' : r }))}
                    value={photoMode === 'text2img' ? aspectRatio : img2imgRatio}
                    onChange={photoMode === 'text2img' ? setAspectRatio : setImg2imgRatio}
                    t={t}
                  />
                  <OptionGroup label="Quality" options={Object.keys(QUALITY_TO_STEPS).map((q) => ({ id: q, label: q }))} value={quality} onChange={setQuality} t={t} />
                  <OptionGroup label="Style" options={PHOTO_STYLES.map((s) => ({ id: s, label: STYLE_LABELS[s] }))} value={styleFilter} onChange={setStyleFilter} t={t} />
                </>
              )}

              {isImg2img && (
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label htmlFor="gen-strength" className="text-xs font-semibold" style={{ color: t.fgMuted }}>Strength {strength.toFixed(2)}</label>
                    <span className="text-xs font-medium" style={{ color: t.pillFg }}>{strengthLabel(strength)}</span>
                  </div>
                  <input id="gen-strength" type="range" min="0.05" max="1" step="0.05" value={strength} onChange={(e) => setStrength(parseFloat(e.target.value))} className="w-full accent-[#6366F1]" />
                  <p className="text-xs mt-1" style={{ color: t.fgSubtle }}>Lower keeps the original composition. Higher gives the model more freedom.</p>
                </div>
              )}

              <button
                onClick={handleGenerate}
                disabled={generateDisabled}
                className={`w-full flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-semibold text-white transition-all duration-150 hover:opacity-90 active:scale-[0.98] disabled:opacity-60 ${focusRing}`}
                style={{ background: 'linear-gradient(135deg, #6366F1, #8B5CF6)', boxShadow: '0 6px 20px rgba(99,102,241,0.35)' }}
              >
                {generating ? (
                  <><Spinner /> Generating...</>
                ) : (
                  <><IconSparkles size={16} /> Generate {tab === 'video' ? 'video' : 'image'}</>
                )}
              </button>
              {isImg2img && !sourceImage && (
                <p className="text-xs text-center -mt-2" style={{ color: t.fgSubtle }}>Upload a source image to continue.</p>
              )}

              {error && (
                <p role="alert" className="text-xs rounded-lg px-3 py-2" style={{ color: '#EF4444', background: 'rgba(239,68,68,0.1)' }}>
                  {error}
                </p>
              )}
            </div>
          </section>

          {/* ---------- Gallery ---------- */}
          <section aria-label="Results" className="min-w-0">
            {tab === 'video' && (
              <>
                <h2 className="text-base font-bold mb-4" style={{ color: t.fg, fontFamily: DISPLAY_FONT }}>
                  Your videos {videoResults.length > 0 && <span className="text-sm font-normal" style={{ color: t.fgSubtle }}>({videoResults.length})</span>}
                </h2>
                {loadingHistory && videoResults.length === 0 && <SkeletonGrid cols="grid-cols-2 2xl:grid-cols-3" ratio={DEFAULT_VIDEO_ASPECT} t={t} />}
                {!loadingHistory && videoResults.length === 0 && <EmptyState kind="video" t={t} />}
                {videoResults.length > 0 && (
                  <div className="grid grid-cols-2 2xl:grid-cols-3 gap-5">
                    {videoResults.map((video) => (
                      <div
                        key={video.id}
                        className="group rounded-2xl overflow-hidden transition-all duration-200 hover:-translate-y-0.5"
                        style={{ background: t.card, border: `1px solid ${t.border}`, boxShadow: t.shadowSm }}
                      >
                        <div className="relative overflow-hidden bg-black" style={{ aspectRatio: video.aspectRatio || DEFAULT_VIDEO_ASPECT }}>
                          {video.status === 'done' && video.videoUrl ? (
                            <video src={video.videoUrl} className="w-full h-full object-contain" controls onLoadedMetadata={(e) => handleVideoMetadataLoaded(video.id, e)} />
                          ) : video.status === 'failed' ? (
                            <div className="w-full h-full flex items-center justify-center text-xs text-center px-3" style={{ color: '#F87171' }}>
                              Generation failed: {video.error || 'unknown error'}
                            </div>
                          ) : (
                            <ProgressOverlay status={video.status} />
                          )}
                        </div>
                        <div className="p-4">
                          <p className="text-xs mb-3 leading-relaxed" style={{ color: t.fgSubtle, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                            {video.prompt}
                          </p>
                          {video.status === 'done' && video.videoUrl && (
                            <div className="flex gap-2">
                              <a
                                href={video.videoUrl}
                                download
                                className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-semibold transition-all hover:opacity-80 ${focusRing}`}
                                style={{ background: t.muted, color: t.fgMuted, border: `1px solid ${t.border}` }}
                              >
                                <IconDownload size={13} /> Save
                              </a>
                              <button
                                onClick={() => onNavigate('editor', { videoUrl: video.videoUrl })}
                                className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-semibold text-white transition-all hover:opacity-80 ${focusRing}`}
                                style={{ background: 'linear-gradient(135deg, #6366F1, #8B5CF6)' }}
                              >
                                <IconEdit size={13} /> Edit
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}

            {tab === 'photo' && (
              <>
                <h2 className="text-base font-bold mb-4" style={{ color: t.fg, fontFamily: DISPLAY_FONT }}>
                  Your images {photoResults.length > 0 && <span className="text-sm font-normal" style={{ color: t.fgSubtle }}>({photoResults.length})</span>}
                </h2>
                {loadingHistory && photoResults.length === 0 && <SkeletonGrid cols="grid-cols-2 2xl:grid-cols-3" ratio="1/1" t={t} />}
                {!loadingHistory && photoResults.length === 0 && <EmptyState kind="photo" t={t} />}
                {photoResults.length > 0 && (
                  <div className="grid grid-cols-2 2xl:grid-cols-3 gap-4">
                    {photoResults.map((photo) => {
                      const showingSource = compareId === photo.id && photo.sourceUrl;
                      return (
                        <div
                          key={photo.id}
                          className="group rounded-2xl overflow-hidden transition-all duration-200 hover:-translate-y-0.5"
                          style={{ background: t.card, border: `1px solid ${t.border}`, boxShadow: t.shadowSm }}
                        >
                          <div
                            className="relative overflow-hidden bg-black flex items-center justify-center"
                            style={{ aspectRatio: photo.naturalRatio || ratioLabelToCss(photo.aspectRatio || aspectRatio) }}
                          >
                            {photo.status === 'done' && photo.imageUrl ? (
                              <>
                                {/* imageUrl / sourceUrl are authenticated blob: URLs (see
                                    fetchImageBlobUrl / fetchSourceImageBlobUrl in api.js).
                                    object-contain + naturalRatio shows the real aspect
                                    ratio with nothing cropped. */}
                                <img
                                  src={showingSource ? photo.sourceUrl : photo.imageUrl}
                                  alt={photo.prompt}
                                  onLoad={(e) => handlePhotoImageLoaded(photo.id, e)}
                                  className="w-full h-full object-contain transition-transform duration-300 group-hover:scale-105"
                                />
                                <div className="absolute inset-0 flex items-center justify-center gap-2 flex-wrap p-2 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-all duration-200" style={{ background: 'rgba(0,0,0,0.55)' }}>
                                  <button
                                    onClick={() => setPreviewPhoto({ ...photo, imageUrl: showingSource ? photo.sourceUrl : photo.imageUrl })}
                                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white hover:opacity-80 ${focusRing}`}
                                    style={{ background: 'rgba(255,255,255,0.15)', backdropFilter: 'blur(8px)' }}
                                  >
                                    <IconEye size={13} /> Preview
                                  </button>
                                  <a
                                    href={photo.imageUrl}
                                    download={`${photo.id}.png`}
                                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white hover:opacity-80 ${focusRing}`}
                                    style={{ background: 'rgba(255,255,255,0.15)', backdropFilter: 'blur(8px)' }}
                                  >
                                    <IconDownload size={13} /> Download
                                  </a>
                                  {photo.mode === 'img2img' && (
                                    <button
                                      onClick={() => handleToggleCompare(photo)}
                                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white hover:opacity-80 ${focusRing}`}
                                      style={{ background: 'rgba(255,255,255,0.15)', backdropFilter: 'blur(8px)' }}
                                    >
                                      <IconCopy size={13} /> {showingSource ? 'Show result' : 'Compare'}
                                    </button>
                                  )}
                                </div>
                                <div className="absolute top-2 left-2 flex gap-1">
                                  <span className="text-xs font-semibold px-2 py-0.5 rounded-full" style={{ background: 'rgba(0,0,0,0.6)', color: '#fff', backdropFilter: 'blur(4px)' }}>
                                    {STYLE_LABELS[photo.style] || photo.style}
                                  </span>
                                  {photo.mode === 'img2img' && (
                                    <span className="text-xs font-semibold px-2 py-0.5 rounded-full" style={{ background: 'rgba(99,102,241,0.85)', color: '#fff', backdropFilter: 'blur(4px)' }}>
                                      {showingSource ? 'Source' : 'Image to image'}
                                    </span>
                                  )}
                                </div>
                              </>
                            ) : photo.status === 'failed' ? (
                              <div className="text-xs text-center px-3" style={{ color: '#F87171' }}>
                                Generation failed: {photo.error || 'unknown error'}
                              </div>
                            ) : photo.mode === 'img2img' && photo.sourceUrl ? (
                              <>
                                <img src={photo.sourceUrl} alt="Source" className="absolute inset-0 w-full h-full object-contain opacity-40" />
                                <div className="absolute inset-0"><ProgressOverlay status={photo.status} /></div>
                              </>
                            ) : (
                              <ProgressOverlay status={photo.status} />
                            )}
                          </div>
                          <div className="p-3">
                            <p className="text-xs leading-relaxed truncate" style={{ color: t.fgSubtle }}>{photo.prompt}</p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </section>
        </main>
      </div>

      {/* Full-screen photo preview */}
      {previewPhoto && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-6"
          style={{ background: 'rgba(0,0,0,0.85)' }}
          onClick={() => setPreviewPhoto(null)}
          role="dialog"
          aria-modal="true"
          aria-label="Image preview"
        >
          <img src={previewPhoto.imageUrl} alt={previewPhoto.prompt} className="max-w-full max-h-full object-contain rounded-lg" onClick={(e) => e.stopPropagation()} />
          <button
            onClick={() => setPreviewPhoto(null)}
            className={`absolute top-6 right-6 w-10 h-10 rounded-full flex items-center justify-center text-white text-xl leading-none ${focusRing}`}
            style={{ background: 'rgba(255,255,255,0.15)', backdropFilter: 'blur(8px)' }}
            aria-label="Close preview"
          >
            ×
          </button>
          <p className="absolute bottom-6 left-1/2 -translate-x-1/2 max-w-2xl text-center text-sm px-4" style={{ color: 'rgba(255,255,255,0.8)' }} onClick={(e) => e.stopPropagation()}>
            {previewPhoto.prompt}
          </p>
        </div>
      )}
    </div>
  );
}