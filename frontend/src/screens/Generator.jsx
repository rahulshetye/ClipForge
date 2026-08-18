import { useState, useEffect } from 'react';
import { useTheme } from '../theme/ThemeContext.jsx';
import { useAuth } from '../theme/AuthContext.jsx';
import Sidebar from '../shared/Sidebar.jsx';
import ThemeToggle from '../shared/ThemeToggle.jsx';
import Spinner from '../shared/Spinner.jsx';
import { part1, imageService } from '../api.js';
import {
  IconVideo, IconImage, IconPlay, IconEye, IconDownload,
  IconWand, IconSparkles, IconEdit, IconCopy,
} from '../icons/index.jsx';

// Real style keys from the Image Generation Service's STYLE_PRESETS -- must
// match exactly, since these get sent straight through as the `style` param.
const PHOTO_STYLES = ['none', 'photorealistic', 'anime', 'oil_painting', 'watercolor', 'cyberpunk', 'sketch', 'pixel_art'];
const ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3'];
const QUALITY_TO_STEPS = { SD: 20, HD: 40, '4K': 60 };

// Real style keys from Part 1's steps/captions.py STYLES -- must match
// exactly, sent straight through as the `captionStyle` param.
const CAPTION_STYLES = ['default', 'boxed', 'highlight'];

// Real voice IDs from Part 1's steps/voiceover.py VOICE_OPTIONS -- must
// match exactly, sent straight through as the `voice` param. `label` is
// just for display; `id` is what's actually sent to the backend.
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

// Backend (assembly.py) renders every video at 1080x1920 -- vertical 9:16 -- unconditionally.
// This is the correct default for the placeholder/loading state before we can read the
// real file's dimensions client-side.
const DEFAULT_VIDEO_ASPECT = '9/16';

function ratioLabelToCss(ratio) {
  // Converts '9:16' style labels (used by the photo aspect picker) into CSS aspect-ratio syntax.
  return ratio === '1:1' ? '1/1' : ratio === '4:3' ? '4/3' : ratio === '9:16' ? '9/16' : '16/9';
}

export default function GeneratorScreen({ onNavigate, onLogout }) {
  const { t } = useTheme();
  const { user } = useAuth();
  const displayName = user?.displayName || user?.email?.split('@')[0] || 'User';
  const initials = displayName.slice(0, 2).toUpperCase();

  const [tab, setTab] = useState('video');
  const [prompt, setPrompt] = useState('');
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

  // Full-screen preview state for photo results.
  const [previewPhoto, setPreviewPhoto] = useState(null);

  // Reload past generations on mount so a page refresh doesn't wipe out
  // everything the user generated. Both video and photo jobs live in the
  // SAME Firestore collection (users/{uid}/jobs) -- video docs have
  // `videoUrl` + `prompt`, photo docs have `final_prompt` and no `videoUrl`.
  // A single part1.listJobs() call pulls both, so we split the results
  // client-side rather than making two separate backend calls.
  //
  // Photo docs currently don't persist `style` or the aspect ratio picked
  // at generation time -- only final_prompt/status/error/createdAt -- so
  // reloaded photo cards fall back to a default badge/ratio until the
  // Image service is updated to save those fields too.
  //
  // Finished photos also need a second, authenticated fetch each (same
  // fetchImageBlobUrl() used at generation time) since /download/{id}
  // requires the Firebase auth header that <img src> can't attach -- so
  // photo cards appear first with a spinner, then swap in their image
  // once that fetch resolves.
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
            style: job.style || 'none', // not persisted by the backend yet -- best-effort default
            error: job.error,
            aspectRatio: job.ratio || '16:9', // not persisted by the backend yet -- best-effort default
            naturalRatio: null, // filled in once the real <img> loads and reports its true size
            imageUrl: null, // filled in below for done jobs
          }))
        );

        // Fetch each finished photo's actual image as an authenticated blob
        // URL, updating its card as each one resolves rather than blocking
        // the whole list on all of them finishing.
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

  // Called once a <video> element loads its real file and reports actual pixel dimensions.
  // Corrects the card's aspect ratio if it ever differs from the DEFAULT_VIDEO_ASPECT guess
  // (e.g. a future scene/export that isn't exactly 1080x1920).
  function handleVideoMetadataLoaded(videoId, e) {
    const { videoWidth, videoHeight } = e.target;
    if (!videoWidth || !videoHeight) return;
    const ratio = `${videoWidth}/${videoHeight}`;
    setVideoResults((prev) =>
      prev.map((v) => (v.id === videoId && v.aspectRatio !== ratio ? { ...v, aspectRatio: ratio } : v))
    );
  }

  // Called once a photo's <img> loads and reports its true natural size.
  // The card starts at a best-guess ratio (from the picker at generation time,
  // or the default) so there's no empty flash, then snaps to the real ratio
  // once known -- no crop, no distortion, no layout glitch.
  function handlePhotoImageLoaded(photoId, e) {
    const { naturalWidth, naturalHeight } = e.target;
    if (!naturalWidth || !naturalHeight) return;
    const ratio = `${naturalWidth}/${naturalHeight}`;
    setPhotoResults((prev) =>
      prev.map((p) => (p.id === photoId && p.naturalRatio !== ratio ? { ...p, naturalRatio: ratio } : p))
    );
  }

  async function handleGeneratePhoto() {
    if (!prompt.trim()) return;
    setGenerating(true);
    setError(null);
    const placeholderId = `pending-${Date.now()}`;
    // Store the aspect ratio picked *at generation time* on the item itself, not just in
    // shared state -- otherwise every card in the grid re-reads whatever the dropdown
    // currently shows, and older photos visually reflow when the user changes it later.
    setPhotoResults((prev) => [
      { id: placeholderId, status: 'queued', prompt, style: styleFilter, aspectRatio: aspectRatio, naturalRatio: null },
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

      // /download/{job_id} requires the same Firebase auth header as every
      // other call -- <img src>/<a href> can't attach that header, so we
      // fetch the image once here (authenticated) and hand the resulting
      // blob: URL to the DOM instead. See api.js fetchImageBlobUrl().
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
            ? { id: jobId, status: job.status, prompt, style: styleFilter, error: job.error, aspectRatio: p.aspectRatio, naturalRatio: null, imageUrl }
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

  // Frees the blob: URL's underlying memory. Call this whenever a photo
  // leaves photoResults (e.g. wire this into your delete-job handler) --
  // otherwise each generated image's blob stays resident for the life of
  // the tab.
  function revokePhotoUrl(photo) {
    if (photo?.imageUrl) {
      URL.revokeObjectURL(photo.imageUrl);
    }
  }

  const handleGenerate = () => (tab === 'video' ? handleGenerateVideo() : handleGeneratePhoto());

  return (
    <div className="flex min-h-screen transition-colors duration-200" style={{ background: t.bg }}>
      <Sidebar screen="generator" onNavigate={onNavigate} onLogout={onLogout} />
      <div className="flex-1 flex flex-col min-w-0">
        <header
          className="flex items-center justify-between px-8 py-4 sticky top-0 z-10 transition-colors duration-200"
          style={{ background: t.headerBg, backdropFilter: 'blur(12px)', borderBottom: `1px solid ${t.border}` }}
        >
          <div>
            <h1 className="text-lg font-bold" style={{ color: t.fg }}>AI Generator</h1>
            <p className="text-xs" style={{ color: t.fgSubtle }}>Describe your vision, let AI do the rest</p>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <div className="w-9 h-9 rounded-full bg-gradient-to-br from-[#6366F1] to-[#8B5CF6] flex items-center justify-center text-white text-sm font-bold shadow-md">
              {initials}
            </div>
          </div>
        </header>

        <main className="flex-1 p-8">
          {/* Tab switcher */}
          <div className="max-w-3xl mx-auto mb-6">
            <div className="inline-flex rounded-2xl p-1 gap-1" style={{ background: t.muted, border: `1px solid ${t.border}` }}>
              {[
                { id: 'video', label: 'Video Generation', icon: <IconVideo size={16} /> },
                { id: 'photo', label: 'Photo Generation', icon: <IconImage size={16} /> },
              ].map((tb) => (
                <button
                  key={tb.id}
                  onClick={() => setTab(tb.id)}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold transition-all duration-150"
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
          </div>

          {/* Prompt area */}
          <div className="max-w-3xl mx-auto mb-6">
            <div className="rounded-2xl p-5 transition-colors duration-200" style={{ background: t.card, border: `1px solid ${t.border}`, boxShadow: t.shadowSm }}>
              <div className="flex items-start gap-3 mb-3">
                <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5" style={{ background: 'linear-gradient(135deg, #6366F1, #8B5CF6)' }}>
                  {tab === 'video' ? <IconVideo size={15} className="text-white" /> : <IconImage size={15} className="text-white" />}
                </div>
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder={
                    tab === 'video'
                      ? 'Describe the video you want to create... e.g. 3 tips to stay productive while working from home'
                      : 'Describe the image you want to generate... e.g. A surreal neon-lit forest with bioluminescent plants, photorealistic, 8K'
                  }
                  rows={4}
                  maxLength={500}
                  className="flex-1 w-full resize-none outline-none text-sm leading-relaxed"
                  style={{ color: t.fg, background: 'transparent' }}
                />
              </div>

              {tab === 'video' && (
                <div className="flex flex-wrap gap-2 mb-3 pb-3" style={{ borderBottom: `1px solid ${t.border}` }}>
                  <div className="flex items-center gap-1.5 rounded-lg px-2 py-1" style={{ background: t.muted }}>
                    <span className="text-xs font-medium" style={{ color: t.fgMuted }}>Captions:</span>
                    {CAPTION_STYLES.map((s) => (
                      <button
                        key={s}
                        onClick={() => setCaptionStyle(s)}
                        className="px-2 py-0.5 rounded text-xs font-semibold transition-all"
                        style={{ background: captionStyle === s ? '#6366F1' : 'transparent', color: captionStyle === s ? '#fff' : t.fgMuted }}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center gap-1.5 rounded-lg px-2 py-1 flex-wrap" style={{ background: t.muted }}>
                    <span className="text-xs font-medium" style={{ color: t.fgMuted }}>Voice:</span>
                    {VOICE_OPTIONS.map((v) => (
                      <button
                        key={v.id}
                        onClick={() => setVoice(v.id)}
                        className="px-2 py-0.5 rounded text-xs font-semibold transition-all"
                        style={{ background: voice === v.id ? '#6366F1' : 'transparent', color: voice === v.id ? '#fff' : t.fgMuted }}
                      >
                        {v.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {tab === 'photo' && (
                <div className="flex flex-wrap gap-2 mb-3 pb-3" style={{ borderBottom: `1px solid ${t.border}` }}>
                  <div className="flex items-center gap-1.5 rounded-lg px-2 py-1" style={{ background: t.muted }}>
                    <span className="text-xs font-medium" style={{ color: t.fgMuted }}>Aspect:</span>
                    {ASPECT_RATIOS.map((r) => (
                      <button
                        key={r}
                        onClick={() => setAspectRatio(r)}
                        className="px-2 py-0.5 rounded text-xs font-semibold transition-all"
                        style={{ background: aspectRatio === r ? '#6366F1' : 'transparent', color: aspectRatio === r ? '#fff' : t.fgMuted }}
                      >
                        {r}
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center gap-1.5 rounded-lg px-2 py-1" style={{ background: t.muted }}>
                    <span className="text-xs font-medium" style={{ color: t.fgMuted }}>Quality:</span>
                    {Object.keys(QUALITY_TO_STEPS).map((q) => (
                      <button
                        key={q}
                        onClick={() => setQuality(q)}
                        className="px-2 py-0.5 rounded text-xs font-semibold transition-all"
                        style={{ background: quality === q ? '#6366F1' : 'transparent', color: quality === q ? '#fff' : t.fgMuted }}
                      >
                        {q}
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center gap-1.5 rounded-lg px-2 py-1 flex-wrap" style={{ background: t.muted }}>
                    <span className="text-xs font-medium" style={{ color: t.fgMuted }}>Style:</span>
                    {PHOTO_STYLES.map((s) => (
                      <button
                        key={s}
                        onClick={() => setStyleFilter(s)}
                        className="px-2 py-0.5 rounded text-xs font-semibold transition-all"
                        style={{ background: styleFilter === s ? '#6366F1' : 'transparent', color: styleFilter === s ? '#fff' : t.fgMuted }}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex items-center justify-between pt-2">
                <span className="text-xs" style={{ color: t.fgSubtle }} />
                <div className="flex items-center gap-3">
                  <span className="text-xs font-mono" style={{ color: t.fgSubtle }}>{prompt.length}/500</span>
                  <button
                    onClick={handleGenerate}
                    disabled={generating || !prompt.trim()}
                    className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold text-white transition-all duration-150 hover:opacity-90 active:scale-[0.98] disabled:opacity-60"
                    style={{ background: 'linear-gradient(135deg, #6366F1, #8B5CF6)', boxShadow: '0 4px 16px rgba(99,102,241,0.3)' }}
                  >
                    {generating ? (
                      <>
                        <Spinner /> Generating...
                      </>
                    ) : (
                      <>
                        <IconSparkles size={16} /> Generate {tab === 'video' ? 'Video' : 'Photo'}
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
            {error && (
              <p className="text-sm mt-3" style={{ color: '#EF4444' }}>
                {error}
              </p>
            )}
          </div>

          {/* Video results */}
          {tab === 'video' && loadingHistory && videoResults.length === 0 && (
            <div className="flex items-center justify-center gap-2 py-10" style={{ color: t.fgSubtle }}>
              <Spinner /> <span className="text-sm">Loading your videos...</span>
            </div>
          )}
          {tab === 'video' && videoResults.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-5">
                <h2 className="text-base font-semibold" style={{ color: t.fg }}>
                  Generated Videos <span className="text-sm font-normal" style={{ color: t.fgSubtle }}>({videoResults.length})</span>
                </h2>
              </div>
              <div className="grid grid-cols-2 xl:grid-cols-3 gap-5">
                {videoResults.map((video) => (
                  <div
                    key={video.id}
                    className="group rounded-2xl overflow-hidden transition-all duration-200 hover:-translate-y-0.5"
                    style={{ background: t.card, border: `1px solid ${t.border}`, boxShadow: t.shadowSm }}
                  >
                    <div
                      className="relative overflow-hidden bg-black"
                      style={{ aspectRatio: video.aspectRatio || DEFAULT_VIDEO_ASPECT }}
                    >
                      {video.status === 'done' && video.videoUrl ? (
                        <video
                          src={video.videoUrl}
                          className="w-full h-full object-contain"
                          controls
                          onLoadedMetadata={(e) => handleVideoMetadataLoaded(video.id, e)}
                        />
                      ) : video.status === 'failed' ? (
                        <div className="w-full h-full flex items-center justify-center text-xs" style={{ color: '#EF4444' }}>
                          Failed: {video.error || 'unknown error'}
                        </div>
                      ) : (
                        <div className="w-full h-full flex flex-col items-center justify-center gap-2 text-white">
                          <Spinner />
                          <span className="text-xs">{video.status || 'processing'}...</span>
                        </div>
                      )}
                    </div>
                    <div className="p-4">
                      <p
                        className="text-xs mb-3 leading-relaxed"
                        style={{ color: t.fgSubtle, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
                      >
                        {video.prompt}
                      </p>
                      {video.status === 'done' && video.videoUrl && (
                        <div className="flex gap-2">
                          <a
                            href={video.videoUrl}
                            download
                            className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded-lg text-xs font-medium transition-all hover:opacity-80"
                            style={{ background: t.muted, color: t.fgMuted, border: `1px solid ${t.border}` }}
                          >
                            <IconDownload size={13} /> Save
                          </a>
                          <button
                            onClick={() => onNavigate('editor', { videoUrl: video.videoUrl })}
                            className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded-lg text-xs font-medium text-white transition-all hover:opacity-80"
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
            </div>
          )}

          {/* Photo results */}
          {tab === 'photo' && loadingHistory && photoResults.length === 0 && (
            <div className="flex items-center justify-center gap-2 py-10" style={{ color: t.fgSubtle }}>
              <Spinner /> <span className="text-sm">Loading your photos...</span>
            </div>
          )}
          {tab === 'photo' && photoResults.length > 0 && (
            <div>
              <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
                <h2 className="text-base font-semibold" style={{ color: t.fg }}>
                  Generated Photos <span className="text-sm font-normal" style={{ color: t.fgSubtle }}>({photoResults.length})</span>
                </h2>
              </div>
              <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
                {photoResults.map((photo) => (
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
                          {/* photo.imageUrl is a local blob: URL fetched with the
                              Firebase auth header already attached (see
                              handleGeneratePhoto / imageService.fetchImageBlobUrl
                              in api.js) -- <img>/<a> can render it directly with
                              no further auth needed.
                              object-contain (not object-cover) + naturalRatio
                              (set once the image loads, via handlePhotoImageLoaded)
                              means the card always shows the image at its real
                              aspect ratio with nothing cropped off. */}
                          <img
                            src={photo.imageUrl}
                            alt={photo.prompt}
                            onLoad={(e) => handlePhotoImageLoaded(photo.id, e)}
                            className="w-full h-full object-contain transition-transform duration-300 group-hover:scale-105"
                          />
                          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 opacity-0 group-hover:opacity-100 transition-all duration-200" style={{ background: 'rgba(0,0,0,0.55)' }}>
                            <div className="flex items-center gap-2">
                              <button
                                onClick={() => setPreviewPhoto(photo)}
                                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white transition-all hover:opacity-80"
                                style={{ background: 'rgba(255,255,255,0.15)', backdropFilter: 'blur(8px)' }}
                              >
                                <IconEye size={13} /> Preview
                              </button>
                              <a
                                href={photo.imageUrl}
                                download={`${photo.id}.png`}
                                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white transition-all hover:opacity-80"
                                style={{ background: 'rgba(255,255,255,0.15)', backdropFilter: 'blur(8px)' }}
                              >
                                <IconDownload size={13} /> Download
                              </a>
                            </div>
                          </div>
                          <div className="absolute top-2 left-2">
                            <span className="text-xs font-semibold px-2 py-0.5 rounded-full" style={{ background: 'rgba(0,0,0,0.6)', color: '#fff', backdropFilter: 'blur(4px)' }}>
                              {photo.style}
                            </span>
                          </div>
                        </>
                      ) : photo.status === 'failed' ? (
                        <div className="text-xs text-center px-2" style={{ color: '#EF4444' }}>
                          Failed: {photo.error || 'unknown error'}
                        </div>
                      ) : (
                        <div className="flex flex-col items-center justify-center gap-2 text-white">
                          <Spinner />
                          <span className="text-xs">{photo.status || 'queued'}...</span>
                        </div>
                      )}
                    </div>
                    <div className="p-3">
                      <p className="text-xs leading-relaxed truncate" style={{ color: t.fgSubtle }}>
                        {photo.prompt}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </main>
      </div>

      {/* Full-screen photo preview lightbox */}
      {previewPhoto && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-6"
          style={{ background: 'rgba(0,0,0,0.85)' }}
          onClick={() => setPreviewPhoto(null)}
        >
          <img
            src={previewPhoto.imageUrl}
            alt={previewPhoto.prompt}
            className="max-w-full max-h-full object-contain rounded-lg"
            onClick={(e) => e.stopPropagation()}
          />
          <button
            onClick={() => setPreviewPhoto(null)}
            className="absolute top-6 right-6 w-10 h-10 rounded-full flex items-center justify-center text-white text-xl leading-none"
            style={{ background: 'rgba(255,255,255,0.15)', backdropFilter: 'blur(8px)' }}
            aria-label="Close preview"
          >
            ×
          </button>
          <p
            className="absolute bottom-6 left-1/2 -translate-x-1/2 max-w-2xl text-center text-sm px-4"
            style={{ color: 'rgba(255,255,255,0.8)' }}
            onClick={(e) => e.stopPropagation()}
          >
            {previewPhoto.prompt}
          </p>
        </div>
      )}
    </div>
  );
}