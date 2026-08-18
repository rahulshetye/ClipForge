import { useState, useRef, useCallback, useEffect } from 'react';
import { useTheme } from '../theme/ThemeContext.jsx';
import { useAuth } from '../theme/AuthContext.jsx';
import Sidebar from '../shared/Sidebar.jsx';
import ThemeToggle from '../shared/ThemeToggle.jsx';
import Spinner from '../shared/Spinner.jsx';
import Toggle from '../shared/Toggle.jsx';
import { part2 } from '../api.js';
import { IconUpload, IconSparkles, IconDownload, IconEye } from '../icons/index.jsx';

// One entry per backend pipeline step (see steps/registry.py STEP_ORDER).
// `id` is sent straight through to the backend's run-all ?steps= query, so
// these must match the registry's step names exactly. Order here also
// defines toggle display order -- actual execution order always follows
// STEP_ORDER below, not this array, since the backend runs steps in
// priority order regardless of how they're listed here.
const FEATURES = [
  { id: 'trim', label: 'Trim & Silence Removal', desc: 'Detect and remove silent gaps, tighten pacing' },
  { id: 'captions', label: 'Captions', desc: 'Transcribe speech into word-level captions' },
  { id: 'subtitle_styles', label: 'Subtitle Styles', desc: 'Burn in styled, readable captions' },
  { id: 'broll', label: 'B-Roll', desc: 'Insert relevant B-roll clips automatically' },
  { id: 'music_selection', label: 'Music Selection', desc: 'Add a fitting background track' },
  { id: 'transitions', label: 'Transitions', desc: 'Add transitions between cuts' },
  { id: 'sound_effects', label: 'Sound Effects', desc: 'Layer in contextual sound effects' },
  { id: 'stickers', label: 'Stickers', desc: 'Overlay animated stickers' },
];

// Mirrors backend steps/registry.py STEP_ORDER -- kept as a separate list
// (rather than just using FEATURES' order) so re-ordering the toggles in the
// UI can never silently change what order steps actually run in.
const STEP_ORDER = [
  'trim',
  'transitions',
  'captions',
  'subtitle_styles',
  'broll',
  'music_selection',
  'sound_effects',
  'stickers',
];

// subtitle_styles is included by default alongside captions -- captions alone
// only produces a transcript, it doesn't burn anything into the video.
const DEFAULT_ENABLED = { trim: true, captions: true, subtitle_styles: true };

// Real values from steps/subtitle_styles.py's STYLES / FONT_PRESETS -- must
// match exactly, sent straight through as stepParams.subtitle_styles.
const SUBTITLE_STYLES = ['default', 'boxed', 'highlight'];
const SUBTITLE_FONTS = [
  'default', 'serif', 'mono', 'modern', 'free-sans', 'free-serif', 'free-mono',
  'carlito', 'caladea', 'bebas', 'anton', 'bangers', 'righteous', 'archivo-black', 'marker',
];

// Best-guess ratio for a past-edit card before its <video> reports real
// dimensions -- uploads are recommended vertical (9:16).
const DEFAULT_EDIT_ASPECT = '9/16';

export default function EditorScreen({ onNavigate, onLogout }) {
  const { t } = useTheme();
  const { user } = useAuth();
  const displayName = user?.displayName || user?.email?.split('@')[0] || 'User';
  const initials = displayName.slice(0, 2).toUpperCase();

  const fileInputRef = useRef(null);

  const [file, setFile] = useState(null);
  const [localPreviewUrl, setLocalPreviewUrl] = useState(null);
  const [status, setStatus] = useState('idle'); // idle | queued | running | done | failed
  const [error, setError] = useState(null);
  const [resultUrl, setResultUrl] = useState(null);
  const [frames, setFrames] = useState([]); // client-extracted preview frames from the result video

  const [features, setFeatures] = useState(() => {
    const initial = {};
    FEATURES.forEach((f) => (initial[f.id] = Boolean(DEFAULT_ENABLED[f.id])));
    return initial;
  });

  const [subtitleStyle, setSubtitleStyle] = useState('default');
  const [subtitleFont, setSubtitleFont] = useState('default');

  // Past, finished videos pulled from the backend. Only projects that
  // actually completed with a real videoUrl belong here -- half-created /
  // never-run / failed projects are filtered out entirely (see the load
  // effect below), since there's nothing to preview or download for those.
  const [pastVideos, setPastVideos] = useState([]);
  const [loadingHistory, setLoadingHistory] = useState(true);

  // Full-screen preview state for past videos.
  const [previewVideo, setPreviewVideo] = useState(null);

  const toggleFeature = (id) => setFeatures((prev) => ({ ...prev, [id]: !prev[id] }));

  // Reload past edits on mount. part2.listProjects() only hits the
  // lightweight Firestore index (projectId, createdAt, filename -- NOT
  // videoUrl/status), so we fetch each project's full detail via
  // part2.getProject(id) to find out which ones actually finished. Only
  // projects that come back with status "done" and a real videoUrl get
  // added to the list -- everything else (idle/never-run, queued, failed)
  // is silently dropped since there's no video to show.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const projects = await part2.listProjects();
        if (cancelled) return;

        projects.forEach(async (p) => {
          const id = p.projectId || p.id;
          try {
            const full = await part2.getProject(id);
            if (cancelled) return;
            if (full.status === 'done' && full.videoUrl) {
              setPastVideos((prev) =>
                prev.some((v) => v.id === id)
                  ? prev
                  : [
                      { id, filename: p.filename || '', videoUrl: full.videoUrl, aspectRatio: DEFAULT_EDIT_ASPECT },
                      ...prev,
                    ]
              );
            }
          } catch (err) {
            console.error('Failed to load project detail:', err);
          }
        });
      } catch (err) {
        console.error('Failed to load edit history:', err);
      } finally {
        if (!cancelled) setLoadingHistory(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Called once a past video's <video> loads its real file and reports
  // actual pixel dimensions, correcting the guessed DEFAULT_EDIT_ASPECT so
  // the card shows the video at its true proportions, uncropped.
  function handlePastVideoMetadataLoaded(videoId, e) {
    const { videoWidth, videoHeight } = e.target;
    if (!videoWidth || !videoHeight) return;
    const ratio = `${videoWidth}/${videoHeight}`;
    setPastVideos((prev) =>
      prev.map((v) => (v.id === videoId && v.aspectRatio !== ratio ? { ...v, aspectRatio: ratio } : v))
    );
  }

  function handleFileSelect(selected) {
    if (!selected) return;
    setFile(selected);
    setLocalPreviewUrl(URL.createObjectURL(selected));
    setResultUrl(null);
    setFrames([]);
    setError(null);
    setStatus('idle');
  }

  // Extracts 4 evenly-spaced frames from the finished result video as quick
  // preview thumbnails -- done client-side via <video> + <canvas>, no backend
  // support needed for this part.
  const extractFrames = useCallback((videoUrl) => {
    const video = document.createElement('video');
    video.src = videoUrl;
    video.crossOrigin = 'anonymous';
    video.muted = true;

    video.addEventListener('loadedmetadata', () => {
      const duration = video.duration;
      const points = [0.2, 0.4, 0.6, 0.8].map((f) => f * duration);
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      const captured = [];

      function captureNext(i) {
        if (i >= points.length) {
          setFrames(captured);
          return;
        }
        video.currentTime = points[i];
      }

      video.addEventListener('seeked', function onSeeked() {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => {
          captured.push(URL.createObjectURL(blob));
          captureNext(captured.length);
        }, 'image/jpeg', 0.85);
      });

      captureNext(0);
    });
  }, []);

  async function handleApply() {
    if (!file) return;

    const enabledSteps = STEP_ORDER.filter((id) => features[id]);
    if (enabledSteps.length === 0) {
      setError('Enable at least one feature.');
      return;
    }

    setStatus('queued');
    setError(null);
    setResultUrl(null);
    setFrames([]);

    try {
      const { projectId } = await part2.createProject(file);

      // Only send subtitle_styles' params if that step is actually enabled --
      // no point sending style/font values for a step that won't run.
      const stepParams = features.subtitle_styles
        ? { subtitle_styles: { style: subtitleStyle, fontName: subtitleFont } }
        : undefined;

      await part2.runAll(projectId, enabledSteps, stepParams);
      const project = await part2.pollProject(projectId, (p) => setStatus(p.status));

      if (project.status === 'done') {
        setStatus('done');
        setResultUrl(project.videoUrl);
        extractFrames(project.videoUrl);
        // Newly finished edit -- add it to Past Videos immediately rather
        // than waiting for the next page load / listProjects() call.
        setPastVideos((prev) => [
          { id: projectId, filename: file.name, videoUrl: project.videoUrl, aspectRatio: DEFAULT_EDIT_ASPECT },
          ...prev,
        ]);
      } else {
        setStatus('failed');
        setError(project.error || 'Editing failed.');
      }
    } catch (err) {
      setStatus('failed');
      setError(err.message);
    }
  }

  const isBusy = status !== 'idle' && status !== 'done' && status !== 'failed';
  const statusLabel = { queued: 'Queued...', running: 'Applying features...' }[status];

  return (
    <div className="flex min-h-screen transition-colors duration-200" style={{ background: t.bg }}>
      <Sidebar screen="editor" onNavigate={onNavigate} onLogout={onLogout} />
      <div className="flex-1 flex flex-col min-w-0">
        <header
          className="flex items-center justify-between px-8 py-4 sticky top-0 z-10 transition-colors duration-200"
          style={{ background: t.headerBg, backdropFilter: 'blur(12px)', borderBottom: `1px solid ${t.border}` }}
        >
          <div>
            <h1 className="text-lg font-bold" style={{ color: t.fg }}>AI Editor</h1>
            <p className="text-xs" style={{ color: t.fgSubtle }}>Upload footage and apply AI editing features</p>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <div className="w-9 h-9 rounded-full bg-gradient-to-br from-[#6366F1] to-[#8B5CF6] flex items-center justify-center text-white text-sm font-bold shadow-md">
              {initials}
            </div>
          </div>
        </header>

        <main className="flex-1 p-8 grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-6">
          {/* Left column: video preview + result frame strip */}
          <div className="space-y-6">
            <div
              className="rounded-2xl overflow-hidden flex items-center justify-center"
              style={{ background: '#000', border: `1px solid ${t.border}`, aspectRatio: '16/9', boxShadow: t.shadowSm }}
            >
              {localPreviewUrl ? (
                <video
                  src={resultUrl || localPreviewUrl}
                  controls
                  className="h-full max-w-full object-contain"
                />
              ) : (
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="flex flex-col items-center gap-3 px-8 py-12 text-white/70 hover:text-white transition-colors"
                >
                  <IconUpload size={32} />
                  <span className="text-sm font-medium">Click to upload a video</span>
                  <span className="text-xs opacity-70">9:16 vertical recommended</span>
                </button>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept="video/*"
                hidden
                onChange={(e) => handleFileSelect(e.target.files?.[0] ?? null)}
              />
            </div>

            {file && (
              <div className="flex items-center justify-between">
                <p className="text-sm truncate" style={{ color: t.fgMuted }}>{file.name}</p>
                <button
                  onClick={handleApply}
                  disabled={isBusy}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold text-white transition-all duration-150 hover:opacity-90 active:scale-[0.98] disabled:opacity-60 shrink-0"
                  style={{ background: 'linear-gradient(135deg, #6366F1, #8B5CF6)', boxShadow: '0 4px 16px rgba(99,102,241,0.3)' }}
                >
                  {isBusy ? (
                    <>
                      <Spinner /> {statusLabel || 'Working...'}
                    </>
                  ) : (
                    <>
                      <IconSparkles size={16} /> Apply Features
                    </>
                  )}
                </button>
              </div>
            )}

            {error && <p className="text-sm" style={{ color: '#EF4444' }}>{error}</p>}

            <div>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold" style={{ color: t.fg }}>After Applying Features</h2>
                {resultUrl && (
                  <a
                    href={resultUrl}
                    download
                    className="flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-lg transition-all hover:opacity-80"
                    style={{ background: t.pillBg, color: t.pillFg }}
                  >
                    <IconDownload size={12} /> Download result
                  </a>
                )}
              </div>
              <div className="grid grid-cols-4 gap-3">
                {[0, 1, 2, 3].map((i) => (
                  <div
                    key={i}
                    className="rounded-xl overflow-hidden flex items-center justify-center"
                    style={{ background: t.muted, border: `1px solid ${t.border}`, aspectRatio: '9/16' }}
                  >
                    {frames[i] ? (
                      <img src={frames[i]} alt={`Preview frame ${i + 1}`} className="w-full h-full object-cover" />
                    ) : status === 'running' || status === 'queued' ? (
                      <Spinner />
                    ) : (
                      <span className="text-xs" style={{ color: t.fgSubtle }}>—</span>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Past videos -- only finished edits with a real videoUrl */}
            {loadingHistory && pastVideos.length === 0 && (
              <div className="flex items-center justify-center gap-2 py-10" style={{ color: t.fgSubtle }}>
                <Spinner /> <span className="text-sm">Loading your past videos...</span>
              </div>
            )}
            {pastVideos.length > 0 && (
              <div>
                <h2 className="text-sm font-semibold mb-3" style={{ color: t.fg }}>
                  Past Videos <span className="text-xs font-normal" style={{ color: t.fgSubtle }}>({pastVideos.length})</span>
                </h2>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                  {pastVideos.map((video) => (
                    <div
                      key={video.id}
                      className="group rounded-xl overflow-hidden transition-all duration-200 hover:-translate-y-0.5"
                      style={{ background: t.card, border: `1px solid ${t.border}`, boxShadow: t.shadowSm }}
                    >
                      <div
                        className="relative overflow-hidden bg-black"
                        style={{ aspectRatio: video.aspectRatio || DEFAULT_EDIT_ASPECT }}
                      >
                        <video
                          src={video.videoUrl}
                          className="w-full h-full object-contain"
                          muted
                          onLoadedMetadata={(e) => handlePastVideoMetadataLoaded(video.id, e)}
                        />
                        <div
                          className="absolute inset-0 flex items-center justify-center gap-2 opacity-0 group-hover:opacity-100 transition-all duration-200"
                          style={{ background: 'rgba(0,0,0,0.55)' }}
                        >
                          <button
                            onClick={() => setPreviewVideo(video)}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white transition-all hover:opacity-80"
                            style={{ background: 'rgba(255,255,255,0.15)', backdropFilter: 'blur(8px)' }}
                          >
                            <IconEye size={13} /> Preview
                          </button>
                          <a
                            href={video.videoUrl}
                            download={video.filename || `${video.id}.mp4`}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white transition-all hover:opacity-80"
                            style={{ background: 'rgba(255,255,255,0.15)', backdropFilter: 'blur(8px)' }}
                          >
                            <IconDownload size={13} /> Download
                          </a>
                        </div>
                      </div>
                      <div className="p-2.5">
                        <p className="text-xs truncate" style={{ color: t.fgSubtle }}>{video.filename}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Right column: feature toggles */}
          <div className="space-y-3">
            {FEATURES.map((feature) => (
              <div key={feature.id}>
                <div
                  className="rounded-xl p-4 flex items-center justify-between gap-3 transition-colors"
                  style={{ background: t.card, border: `1px solid ${t.border}`, boxShadow: t.shadowSm }}
                >
                  <div className="min-w-0">
                    <p className="text-sm font-semibold" style={{ color: t.fg }}>{feature.label}</p>
                    <p className="text-xs mt-0.5" style={{ color: t.fgSubtle }}>{feature.desc}</p>
                  </div>
                  <Toggle checked={features[feature.id]} onChange={() => toggleFeature(feature.id)} />
                </div>

                {/* Subtitle style/font picker -- only shown when subtitle_styles is enabled */}
                {feature.id === 'subtitle_styles' && features.subtitle_styles && (
                  <div
                    className="rounded-xl p-3 mt-2 space-y-2"
                    style={{ background: t.muted, border: `1px solid ${t.border}` }}
                  >
                    <div>
                      <span className="text-xs font-medium block mb-1.5" style={{ color: t.fgMuted }}>Style</span>
                      <div className="flex flex-wrap gap-1.5">
                        {SUBTITLE_STYLES.map((s) => (
                          <button
                            key={s}
                            onClick={() => setSubtitleStyle(s)}
                            className="px-2 py-0.5 rounded text-xs font-semibold transition-all"
                            style={{ background: subtitleStyle === s ? '#6366F1' : 'transparent', color: subtitleStyle === s ? '#fff' : t.fgMuted, border: `1px solid ${subtitleStyle === s ? '#6366F1' : t.border}` }}
                          >
                            {s}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <span className="text-xs font-medium block mb-1.5" style={{ color: t.fgMuted }}>Font</span>
                      <select
                        value={subtitleFont}
                        onChange={(e) => setSubtitleFont(e.target.value)}
                        className="w-full text-xs py-1.5 px-2 rounded-lg"
                        style={{ background: t.card, color: t.fg, border: `1px solid ${t.border}` }}
                      >
                        {SUBTITLE_FONTS.map((f) => (
                          <option key={f} value={f}>{f}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </main>
      </div>

      {/* Full-screen past-video preview lightbox */}
      {previewVideo && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-6"
          style={{ background: 'rgba(0,0,0,0.85)' }}
          onClick={() => setPreviewVideo(null)}
        >
          <video
            src={previewVideo.videoUrl}
            controls
            autoPlay
            className="max-w-full max-h-full rounded-lg"
            onClick={(e) => e.stopPropagation()}
          />
          <button
            onClick={() => setPreviewVideo(null)}
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
            {previewVideo.filename}
          </p>
        </div>
      )}
    </div>
  );
}