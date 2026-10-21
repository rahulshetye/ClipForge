import { useState, useRef, useCallback, useEffect } from 'react';
import { useTheme } from '../theme/ThemeContext.jsx';
import Sidebar from '../shared/Sidebar.jsx';
import ThemeToggle from '../shared/ThemeToggle.jsx';
import AvatarMenu from '../shared/Avatar.jsx';
import Spinner from '../shared/Spinner.jsx';
import Toggle from '../shared/Toggle.jsx';
import { part2 } from '../api.js';
import { IconUpload, IconSparkles, IconDownload, IconEye, IconShare } from '../icons/index.jsx';

const DISPLAY_FONT = "'Sora', 'Inter', system-ui, sans-serif";

// One entry per backend pipeline step (see steps/registry.py STEP_ORDER).
// `id` is sent in the run-all request body's `steps` array, so these must
// match the registry's step names exactly. Actual execution order always
// follows STEP_ORDER below, not this array.
const FEATURES = [
  { id: 'trim', label: 'Trim and silence removal', desc: 'Cut silent gaps and tighten the pacing', group: 'pacing' },
  { id: 'transitions', label: 'Transitions', desc: 'Smooth the cuts between scenes', group: 'pacing' },
  { id: 'captions', label: 'Captions', desc: 'Transcribe speech into word-level captions', group: 'captions' },
  { id: 'subtitle_styles', label: 'Subtitle styles', desc: 'Burn styled, readable captions into the video', group: 'captions' },
  { id: 'broll', label: 'B-roll', desc: 'Insert relevant footage automatically', group: 'enhance' },
  { id: 'music_selection', label: 'Background music', desc: 'Add a fitting track under the voice', group: 'enhance' },
  { id: 'sound_effects', label: 'Sound effects', desc: 'Layer in contextual sound effects', group: 'enhance' },
  { id: 'stickers', label: 'Stickers', desc: 'Overlay animated stickers', group: 'enhance' },
];

const GROUPS = [
  { id: 'pacing', title: 'Pacing', hint: 'Make it tighter' },
  { id: 'captions', title: 'Captions', hint: 'Make it readable on mute' },
  { id: 'enhance', title: 'Enhancements', hint: 'Add polish' },
];

// Mirrors backend steps/registry.py STEP_ORDER, kept separate from FEATURES
// so re-ordering the UI can never silently change the run order.
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

// subtitle_styles is on by default next to captions: captions alone only
// produces a transcript, it doesn't burn anything into the video.
const DEFAULT_ENABLED = { trim: true, captions: true, subtitle_styles: true };

const PRESETS = [
  { id: 'captions', label: 'Captions only', steps: ['captions', 'subtitle_styles'] },
  { id: 'clean', label: 'Clean cut', steps: ['trim', 'transitions'] },
  { id: 'social', label: 'Social ready', steps: ['trim', 'captions', 'subtitle_styles', 'music_selection'] },
  { id: 'full', label: 'Full polish', steps: STEP_ORDER },
];

// Real values from steps/subtitle_styles.py STYLES / FONT_PRESETS.
const SUBTITLE_STYLES = ['default', 'boxed', 'highlight'];
const SUBTITLE_FONTS = [
  'default', 'serif', 'mono', 'modern', 'free-sans', 'free-serif', 'free-mono',
  'carlito', 'caladea', 'bebas', 'anton', 'bangers', 'righteous', 'archivo-black', 'marker',
  // Devanagari (Hindi / Marathi) fonts draw joined letters correctly.
  'noto-deva', 'mukta', 'tiro-deva',
];

// Fonts that can draw Devanagari. For any other font the backend swaps to
// Noto Sans Devanagari for Hindi/Marathi captions so text never shows as boxes.
const DEVANAGARI_FONTS = ['noto-deva', 'mukta', 'tiro-deva', 'modern'];

// Mirrors backend steps/captions.py LANG_CONFIG keys (plus "auto"). Sent as
// stepParams.captions.language; the backend rejects anything else with a 400.
const CAPTION_LANGUAGES = [
  { id: 'auto', label: 'Auto-detect' },
  { id: 'en', label: 'English' },
  { id: 'hi', label: 'Hindi' },
  { id: 'mr', label: 'Marathi' },
];

const DEVANAGARI_LANGUAGES = ['hi', 'mr'];

// Sent as stepParams.captions.script. Only meaningful for Hindi and Marathi.
const CAPTION_SCRIPTS = [
  { id: 'native', label: 'देवनागरी (Devanagari)' },
  { id: 'roman', label: 'Roman letters' },
];

const langLabel = (id) => CAPTION_LANGUAGES.find((l) => l.id === id)?.label || id;

// Pulls caption warnings out of a finished project. captions.run() hands
// these to record_step as `caption_meta`; where record_step stores it is
// unverified, so both likely locations are checked. Adjust if warnings
// don't show up: open a finished project.json to see where it landed.
function extractCaptionWarnings(project) {
  return (
    project.caption_meta?.warnings ||
    project.steps?.captions?.caption_meta?.warnings ||
    []
  );
}

// Best-guess ratio for a past-edit card before its <video> reports real size.
const DEFAULT_EDIT_ASPECT = '9/16';

const focusRing = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6366F1]';

/* ---------------- Small UI pieces ---------------- */

const ICON_PATHS = {
  trim: 'M6 9a3 3 0 100-6 3 3 0 000 6zm0 12a3 3 0 100-6 3 3 0 000 6zM20 4L8.12 15.88M14.47 14.48L20 20M8.12 8.12L12 12',
  transitions: 'M3 12h7m4 0h7M10 7l4 5-4 5',
  captions: 'M3 5h18v14H3zM7 11h4M13 11h4M7 15h6',
  subtitle_styles: 'M4 7V4h16v3M9 20h6M12 4v16',
  broll: 'M4 4h16v16H4zM8 4v16M16 4v16M4 8h4M4 12h4M4 16h4M16 8h4M16 12h4M16 16h4',
  music_selection: 'M9 18V5l12-2v13M9 18a3 3 0 11-6 0 3 3 0 016 0zM21 16a3 3 0 11-6 0 3 3 0 016 0z',
  sound_effects: 'M11 5L6 9H2v6h4l5 4V5zM15.5 8.5a5 5 0 010 7M19 5a10 10 0 010 14',
  stickers: 'M12 21a9 9 0 100-18 9 9 0 000 18zM8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01',
};

function FeatureIcon({ id, size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICON_PATHS[id]} />
    </svg>
  );
}

function Chip({ active, onClick, children, t, mono }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-all ${focusRing}`}
      style={{
        background: active ? '#6366F1' : 'transparent',
        color: active ? '#fff' : t.fgMuted,
        border: `1px solid ${active ? '#6366F1' : t.border}`,
        fontFamily: mono ? 'inherit' : undefined,
      }}
    >
      {children}
    </button>
  );
}

function Callout({ tone, children, t }) {
  const tones = {
    warn: { c: '#D97706', bg: 'rgba(245,158,11,0.12)' },
    error: { c: '#EF4444', bg: 'rgba(239,68,68,0.1)' },
    info: { c: t.pillFg, bg: t.pillBg },
  };
  const s = tones[tone];
  return (
    <div role={tone === 'error' ? 'alert' : undefined} className="rounded-xl px-4 py-3 text-sm leading-relaxed" style={{ background: s.bg, color: s.c }}>
      {children}
    </div>
  );
}

function StageEmpty({ onPick, t }) {
  return (
    <button
      onClick={onPick}
      className={`w-full h-full flex flex-col items-center justify-center gap-5 px-8 text-center rounded-[inherit] ${focusRing}`}
      style={{ color: '#fff' }}
    >
      <svg viewBox="0 0 240 130" className="w-60" aria-hidden="true">
        <defs>
          <linearGradient id="ed-g" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#6366F1" />
            <stop offset="1" stopColor="#8B5CF6" />
          </linearGradient>
        </defs>
        <rect x="88" y="4" width="64" height="104" rx="12" fill="url(#ed-g)" />
        <rect x="95" y="11" width="50" height="90" rx="7" fill="rgba(255,255,255,0.2)" />
        <path d="M112 44v20l17-10z" fill="#fff" />
        <rect x="100" y="82" width="40" height="6" rx="3" fill="#FDE047" />
        <rect x="12" y="116" width="216" height="8" rx="4" fill="rgba(255,255,255,0.12)" />
        <rect x="12" y="116" width="70" height="8" rx="4" fill="rgba(165,180,252,0.8)" />
        <rect x="86" y="116" width="52" height="8" rx="4" fill="rgba(253,224,71,0.8)" />
        <rect x="142" y="116" width="86" height="8" rx="4" fill="rgba(103,232,249,0.7)" />
        <path d="M44 56l-14 0m7-7l-7 7 7 7" stroke="rgba(255,255,255,0.35)" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" transform="translate(0,-2)" />
        <path d="M196 56l14 0m-7-7l7 7-7 7" stroke="rgba(255,255,255,0.35)" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" transform="translate(0,-2)" />
      </svg>
      <div>
        <p className="text-base font-semibold flex items-center justify-center gap-2" style={{ fontFamily: DISPLAY_FONT }}>
          <IconUpload size={18} /> Drop a video here, or click to browse
        </p>
        <p className="text-sm mt-1.5" style={{ color: 'rgba(255,255,255,0.65)' }}>
          Vertical 9:16 works best. Captions can be added in English, Hindi or Marathi.
        </p>
      </div>
    </button>
  );
}

export default function EditorScreen({ onNavigate, onLogout }) {
  const { t } = useTheme();

  const fileInputRef = useRef(null);
  // The backend project for the current upload, kept so a mismatch prompt
  // can re-run captions on the SAME project instead of re-uploading.
  const projectIdRef = useRef(null);

  const [file, setFile] = useState(null);
  const [localPreviewUrl, setLocalPreviewUrl] = useState(null);
  const [status, setStatus] = useState('idle'); // idle | queued | running | done | failed
  const [error, setError] = useState(null);
  const [resultUrl, setResultUrl] = useState(null);
  const [showResult, setShowResult] = useState(true); // stage toggle: edited vs original
  const [frames, setFrames] = useState([]);

  // dragenter/dragleave fire for every child the cursor crosses, so a plain
  // boolean flickers. Counting enters/leaves avoids that.
  const [isDragging, setIsDragging] = useState(false);
  const dragCounterRef = useRef(0);

  const [features, setFeatures] = useState(() => {
    const initial = {};
    FEATURES.forEach((f) => (initial[f.id] = Boolean(DEFAULT_ENABLED[f.id])));
    return initial;
  });

  const [subtitleStyle, setSubtitleStyle] = useState('default');
  const [subtitleFont, setSubtitleFont] = useState('default');

  const [captionLanguage, setCaptionLanguage] = useState('auto');
  const [captionScript, setCaptionScript] = useState('native');
  // Set when the backend says the chosen language doesn't match the audio:
  // { code, requested, detected, confidence }.
  const [mismatch, setMismatch] = useState(null);
  const [captionWarnings, setCaptionWarnings] = useState([]);

  // Only projects that completed with a real videoUrl belong here.
  const [pastVideos, setPastVideos] = useState([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [previewVideo, setPreviewVideo] = useState(null);

  const toggleFeature = (id) => setFeatures((prev) => ({ ...prev, [id]: !prev[id] }));

  function applyPreset(steps) {
    const next = {};
    FEATURES.forEach((f) => (next[f.id] = steps.includes(f.id)));
    setFeatures(next);
    setError(null);
  }

  // Reload past edits on mount. listProjects() only returns the lightweight
  // Firestore index (no videoUrl/status), so each project's detail is fetched
  // and only status "done" + real videoUrl projects are kept.
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

  // Corrects the guessed DEFAULT_EDIT_ASPECT once the real size is known.
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
    if (localPreviewUrl) URL.revokeObjectURL(localPreviewUrl);
    setFile(selected);
    setLocalPreviewUrl(URL.createObjectURL(selected));
    setResultUrl(null);
    setShowResult(true);
    setFrames([]);
    setError(null);
    setMismatch(null);
    setCaptionWarnings([]);
    projectIdRef.current = null;
    setStatus('idle');
  }

  // 4 evenly-spaced preview frames from the finished video, extracted
  // client-side via <video> + <canvas>. No backend support needed.
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

  // Builds run-all's `stepParams`, only for enabled steps. Keys are camelCase
  // on the wire; the backend converts to snake_case before each step's run().
  // captions uses onMismatch "raise" so a wrong language fails the job BEFORE
  // the slow transcription and the UI can ask what to do. `captionOverrides`
  // lets the mismatch prompt re-run with a different language / onMismatch.
  function buildStepParams(captionOverrides = {}) {
    const params = {};
    if (features.subtitle_styles) {
      params.subtitle_styles = { style: subtitleStyle, fontName: subtitleFont };
    }
    if (features.captions) {
      params.captions = {
        language: captionLanguage,
        script: captionScript,
        onMismatch: 'raise',
        ...captionOverrides,
      };
    }
    return Object.keys(params).length > 0 ? params : undefined;
  }

  // Runs the pipeline on an existing project and handles all three outcomes:
  // done, a language mismatch (needs a user decision), or a plain failure.
  async function runPipeline(projectId, steps, stepParams, fileName) {
    setStatus('queued');
    setError(null);
    setResultUrl(null);
    setFrames([]);
    setMismatch(null);
    setCaptionWarnings([]);

    try {
      await part2.runAll(projectId, steps, stepParams);
      const project = await part2.pollProject(projectId, (p) => setStatus(p.status));

      if (project.status === 'done') {
        setStatus('done');
        setResultUrl(project.videoUrl);
        setShowResult(true);
        extractFrames(project.videoUrl);
        setCaptionWarnings(extractCaptionWarnings(project));
        // Add to Past Videos immediately instead of waiting for a reload.
        setPastVideos((prev) =>
          prev.some((v) => v.id === projectId)
            ? prev
            : [
                { id: projectId, filename: fileName, videoUrl: project.videoUrl, aspectRatio: DEFAULT_EDIT_ASPECT },
                ...prev,
              ]
        );
      } else if (project.errorDetails?.code === 'language_mismatch') {
        setStatus('failed');
        setMismatch(project.errorDetails);
      } else {
        setStatus('failed');
        setError(project.error || 'Editing failed.');
      }
    } catch (err) {
      setStatus('failed');
      setError(err.message);
    }
  }

  async function handleApply() {
    if (!file) return;

    const enabledSteps = STEP_ORDER.filter((id) => features[id]);
    if (enabledSteps.length === 0) {
      setError('Turn on at least one feature to continue.');
      return;
    }

    setStatus('queued');
    setError(null);

    try {
      const { projectId } = await part2.createProject(file);
      projectIdRef.current = projectId;
      await runPipeline(projectId, enabledSteps, buildStepParams(), file.name);
    } catch (err) {
      setStatus('failed');
      setError(err.message);
    }
  }

  // Re-runs on the SAME project, starting at captions. Steps before captions
  // (trim, transitions) already ran before the mismatch was detected, and
  // running them again could apply them twice.
  function resumeFromCaptions(captionOverrides) {
    if (!projectIdRef.current || !file) return;
    const enabledSteps = STEP_ORDER.filter((id) => features[id]);
    const resumeSteps = enabledSteps.slice(enabledSteps.indexOf('captions'));
    runPipeline(projectIdRef.current, resumeSteps, buildStepParams(captionOverrides), file.name);
  }

  const isBusy = status !== 'idle' && status !== 'done' && status !== 'failed';
  const statusLabel = { queued: 'Queued...', running: 'Applying features...' }[status];
  const enabledSteps = STEP_ORDER.filter((id) => features[id]);

  const showScriptPicker = captionLanguage === 'auto' || DEVANAGARI_LANGUAGES.includes(captionLanguage);
  const showDevanagariFontHint =
    features.captions &&
    (captionLanguage === 'auto' || DEVANAGARI_LANGUAGES.includes(captionLanguage)) &&
    captionScript === 'native' &&
    !DEVANAGARI_FONTS.includes(subtitleFont);

  // ---- Drag-and-drop handlers for the stage ----
  function handleDragEnter(e) {
    e.preventDefault();
    if (isBusy) return;
    dragCounterRef.current += 1;
    if (e.dataTransfer?.types?.includes('Files')) setIsDragging(true);
  }

  function handleDragOver(e) {
    // Must preventDefault or the browser won't allow a drop here.
    e.preventDefault();
  }

  function handleDragLeave(e) {
    e.preventDefault();
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
    if (dragCounterRef.current === 0) setIsDragging(false);
  }

  function handleDrop(e) {
    e.preventDefault();
    dragCounterRef.current = 0;
    setIsDragging(false);
    if (isBusy) return;

    const dropped = e.dataTransfer?.files?.[0];
    if (!dropped) return;
    if (!dropped.type.startsWith('video/')) {
      setError('Please drop a video file.');
      return;
    }
    handleFileSelect(dropped);
  }

  const stageSrc = showResult && resultUrl ? resultUrl : localPreviewUrl;
  const applyDisabled = isBusy || !file || enabledSteps.length === 0;

  return (
    <div className="flex min-h-screen transition-colors duration-200" style={{ background: t.bg }}>
      <Sidebar screen="editor" onNavigate={onNavigate} onLogout={onLogout} />
      <div className="flex-1 flex flex-col min-w-0">
        <header
          className="flex items-center justify-between px-8 py-4 sticky top-0 z-20 transition-colors duration-200"
          style={{ background: t.headerBg, backdropFilter: 'blur(12px)', borderBottom: `1px solid ${t.border}` }}
        >
          <div>
            <h1 className="text-lg font-bold" style={{ color: t.fg, fontFamily: DISPLAY_FONT }}>AI Editor</h1>
            <p className="text-xs" style={{ color: t.fgSubtle }}>Upload footage, choose what the AI should do, and get a finished cut</p>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <AvatarMenu onNavigate={onNavigate} onLogout={onLogout} />
          </div>
        </header>

        <main className="flex-1 p-6 lg:p-8 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_400px] gap-8 items-start">
          {/* ================= Left: stage + results ================= */}
          <div className="space-y-5 min-w-0">
            <div
              className="relative rounded-2xl overflow-hidden flex items-center justify-center transition-all duration-150"
              style={{
                background: 'radial-gradient(ellipse at 50% 0%, #1E1B4B 0%, #0B1020 70%)',
                border: isDragging ? '2px dashed #6366F1' : `1px solid ${t.border}`,
                height: 'min(68vh, 640px)',
                minHeight: 380,
                boxShadow: isDragging ? '0 0 0 4px rgba(99,102,241,0.25)' : t.shadowMd,
              }}
              onDragEnter={handleDragEnter}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            >
              {localPreviewUrl ? (
                <video key={stageSrc} src={stageSrc} controls className="h-full max-w-full object-contain" />
              ) : (
                <StageEmpty onPick={() => fileInputRef.current?.click()} t={t} />
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept="video/*"
                hidden
                onChange={(e) => {
                  handleFileSelect(e.target.files?.[0] ?? null);
                  // Reset so picking the same file again still fires onChange.
                  e.target.value = '';
                }}
              />

              {/* Original / Edited toggle */}
              {resultUrl && !isBusy && (
                <div className="absolute top-3 left-3 flex rounded-lg p-0.5" role="group" aria-label="Compare versions" style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(8px)' }}>
                  {[
                    { v: false, label: 'Original' },
                    { v: true, label: 'Edited' },
                  ].map((o) => (
                    <button
                      key={o.label}
                      onClick={() => setShowResult(o.v)}
                      aria-pressed={showResult === o.v}
                      className={`px-3 py-1 rounded-md text-xs font-semibold transition-all ${focusRing}`}
                      style={{ background: showResult === o.v ? '#6366F1' : 'transparent', color: '#fff' }}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
              )}

              {/* Working overlay */}
              {isBusy && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 px-6 text-center text-white" style={{ background: 'rgba(11,16,32,0.82)', backdropFilter: 'blur(4px)' }} role="status">
                  <Spinner />
                  <div>
                    <p className="text-base font-semibold" style={{ fontFamily: DISPLAY_FONT }}>{statusLabel || 'Working...'}</p>
                    <p className="text-sm mt-1" style={{ color: 'rgba(255,255,255,0.65)' }}>This can take a few minutes. You can stay on this page.</p>
                  </div>
                  <div className="flex flex-wrap justify-center gap-1.5 max-w-md">
                    {enabledSteps.map((id) => (
                      <span key={id} className="flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full" style={{ background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.16)' }}>
                        <FeatureIcon id={id} size={12} /> {FEATURES.find((f) => f.id === id)?.label}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Drop overlay. pointer-events-none so it doesn't trigger dragleave (flicker). */}
              {isDragging && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-white pointer-events-none" style={{ background: 'rgba(99,102,241,0.4)', backdropFilter: 'blur(2px)' }}>
                  <IconUpload size={36} />
                  <span className="text-sm font-semibold">Drop your video to start</span>
                </div>
              )}
            </div>

            {file && (
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm truncate" style={{ color: t.fgMuted }}>{file.name}</p>
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isBusy}
                  className={`text-xs font-semibold px-3 py-1.5 rounded-lg shrink-0 transition-all hover:opacity-80 disabled:opacity-50 ${focusRing}`}
                  style={{ background: t.muted, color: t.fgMuted, border: `1px solid ${t.border}` }}
                >
                  Replace video
                </button>
              </div>
            )}

            {error && <Callout tone="error" t={t}>{error}</Callout>}

            {/* Wrong-language prompt. Nothing was transcribed yet, so either choice re-runs from captions. */}
            {mismatch && (
              <div className="rounded-xl p-4 space-y-3" style={{ background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.35)' }}>
                <p className="text-sm" style={{ color: t.fg }}>
                  You chose <strong>{langLabel(mismatch.requested)}</strong>, but the audio sounds like{' '}
                  <strong>{langLabel(mismatch.detected)}</strong> ({Math.round((mismatch.confidence ?? 0) * 100)}% sure). Which should we use?
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => resumeFromCaptions({ language: mismatch.detected })}
                    disabled={isBusy}
                    className={`px-3.5 py-2 rounded-lg text-xs font-semibold text-white transition-all hover:opacity-90 disabled:opacity-60 ${focusRing}`}
                    style={{ background: '#6366F1' }}
                  >
                    Use {langLabel(mismatch.detected)}
                  </button>
                  <button
                    onClick={() => resumeFromCaptions({ language: mismatch.requested, onMismatch: 'warn' })}
                    disabled={isBusy}
                    className={`px-3.5 py-2 rounded-lg text-xs font-semibold transition-all hover:opacity-80 disabled:opacity-60 ${focusRing}`}
                    style={{ color: t.fgMuted, border: `1px solid ${t.border}`, background: t.card }}
                  >
                    Keep {langLabel(mismatch.requested)}
                  </button>
                </div>
              </div>
            )}

            {captionWarnings.map((warning, i) => (
              <Callout key={i} tone="warn" t={t}>{warning}</Callout>
            ))}

            {/* Done: next actions */}
            {status === 'done' && resultUrl && (
              <div className="rounded-2xl p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4" style={{ background: t.card, border: `1px solid ${t.border}`, boxShadow: t.shadowSm }}>
                <div className="flex items-center gap-3">
                  <span className="w-9 h-9 rounded-full flex items-center justify-center text-white text-sm shrink-0" style={{ background: '#22C55E' }} aria-hidden="true">✓</span>
                  <div>
                    <p className="text-sm font-bold" style={{ color: t.fg, fontFamily: DISPLAY_FONT }}>Your edit is ready</p>
                    <p className="text-xs" style={{ color: t.fgSubtle }}>Compare it with the original above, then download or publish it.</p>
                  </div>
                </div>
                <div className="flex gap-2 shrink-0">
                  <a
                    href={resultUrl}
                    download
                    className={`flex items-center gap-1.5 text-xs font-semibold px-4 py-2.5 rounded-xl transition-all hover:opacity-80 ${focusRing}`}
                    style={{ background: t.muted, color: t.fg, border: `1px solid ${t.border}` }}
                  >
                    <IconDownload size={14} /> Download
                  </a>
                  <button
                    onClick={() => onNavigate('publisher', { videoUrl: resultUrl })}
                    className={`flex items-center gap-1.5 text-xs font-semibold px-4 py-2.5 rounded-xl text-white transition-all hover:opacity-90 ${focusRing}`}
                    style={{ background: 'linear-gradient(135deg, #6366F1, #8B5CF6)', boxShadow: '0 4px 14px rgba(99,102,241,0.3)' }}
                  >
                    <IconShare size={14} /> Publish
                  </button>
                </div>
              </div>
            )}

            {/* Preview frames: only once there is something to show */}
            {(isBusy || frames.length > 0) && (
              <div>
                <h2 className="text-sm font-bold mb-3" style={{ color: t.fg, fontFamily: DISPLAY_FONT }}>Frames from your edit</h2>
                <div className="grid grid-cols-4 gap-3">
                  {[0, 1, 2, 3].map((i) => (
                    <div key={i} className="rounded-xl overflow-hidden flex items-center justify-center" style={{ background: t.muted, border: `1px solid ${t.border}`, aspectRatio: '9/16' }}>
                      {frames[i] ? (
                        <img src={frames[i]} alt={`Preview frame ${i + 1}`} className="w-full h-full object-cover" />
                      ) : isBusy ? (
                        <Spinner />
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Past videos: only finished edits with a real videoUrl */}
            {loadingHistory && pastVideos.length === 0 && (
              <div className="flex items-center justify-center gap-2 py-10" style={{ color: t.fgSubtle }}>
                <Spinner /> <span className="text-sm">Loading your past edits...</span>
              </div>
            )}
            {pastVideos.length > 0 && (
              <div>
                <h2 className="text-sm font-bold mb-3" style={{ color: t.fg, fontFamily: DISPLAY_FONT }}>
                  Your edits <span className="text-xs font-normal" style={{ color: t.fgSubtle }}>({pastVideos.length})</span>
                </h2>
                <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-4">
                  {pastVideos.map((video) => (
                    <div key={video.id} className="group rounded-xl overflow-hidden transition-all duration-200 hover:-translate-y-0.5" style={{ background: t.card, border: `1px solid ${t.border}`, boxShadow: t.shadowSm }}>
                      <div className="relative overflow-hidden bg-black" style={{ aspectRatio: video.aspectRatio || DEFAULT_EDIT_ASPECT }}>
                        <video src={video.videoUrl} className="w-full h-full object-contain" muted onLoadedMetadata={(e) => handlePastVideoMetadataLoaded(video.id, e)} />
                        <div className="absolute inset-0 flex items-center justify-center gap-2 flex-wrap p-2 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-all duration-200" style={{ background: 'rgba(0,0,0,0.55)' }}>
                          <button
                            onClick={() => setPreviewVideo(video)}
                            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white hover:opacity-80 ${focusRing}`}
                            style={{ background: 'rgba(255,255,255,0.15)', backdropFilter: 'blur(8px)' }}
                          >
                            <IconEye size={13} /> Preview
                          </button>
                          <a
                            href={video.videoUrl}
                            download={video.filename || `${video.id}.mp4`}
                            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white hover:opacity-80 ${focusRing}`}
                            style={{ background: 'rgba(255,255,255,0.15)', backdropFilter: 'blur(8px)' }}
                          >
                            <IconDownload size={13} /> Download
                          </a>
                        </div>
                      </div>
                      <div className="p-2.5">
                        <p className="text-xs truncate" style={{ color: t.fgSubtle }}>{video.filename || 'Untitled edit'}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* ================= Right: edit recipe ================= */}
          <aside className="space-y-5" aria-label="Edit options">
            <div>
              <h2 className="text-base font-bold" style={{ color: t.fg, fontFamily: DISPLAY_FONT }}>What should the AI do?</h2>
              <p className="text-xs mt-1" style={{ color: t.fgSubtle }}>Pick a starting point, then fine-tune. Steps always run in the numbered order.</p>
              <div className="flex flex-wrap gap-1.5 mt-3">
                {PRESETS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => applyPreset(p.steps)}
                    disabled={isBusy}
                    className={`text-xs font-semibold px-3 py-1.5 rounded-full transition-all hover:opacity-80 disabled:opacity-50 ${focusRing}`}
                    style={{ background: t.pillBg, color: t.pillFg, border: `1px solid ${t.pillBorder}` }}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            {GROUPS.map((group) => (
              <section key={group.id} className="space-y-2.5" aria-label={group.title}>
                <div className="flex items-baseline justify-between">
                  <h3 className="text-sm font-semibold" style={{ color: t.fg }}>{group.title}</h3>
                  <span className="text-xs" style={{ color: t.fgSubtle }}>{group.hint}</span>
                </div>

                {FEATURES.filter((f) => f.group === group.id).map((feature) => {
                  const on = features[feature.id];
                  const order = enabledSteps.indexOf(feature.id) + 1;
                  return (
                    <div key={feature.id}>
                      <div
                        className="rounded-xl p-3.5 flex items-center gap-3 transition-all"
                        style={{
                          background: t.card,
                          border: `1px solid ${on ? '#6366F1' : t.border}`,
                          boxShadow: on ? '0 0 0 3px rgba(99,102,241,0.12)' : t.shadowSm,
                        }}
                      >
                        <span
                          className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 transition-all"
                          style={{ background: on ? 'linear-gradient(135deg, #6366F1, #8B5CF6)' : t.muted, color: on ? '#fff' : t.fgMuted }}
                        >
                          <FeatureIcon id={feature.id} />
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold flex items-center gap-2" style={{ color: t.fg }}>
                            {feature.label}
                            {on && (
                              <span className="w-4 h-4 rounded-full text-[10px] font-bold flex items-center justify-center text-white shrink-0" style={{ background: '#6366F1' }} title={`Runs as step ${order}`}>
                                {order}
                              </span>
                            )}
                          </p>
                          <p className="text-xs mt-0.5" style={{ color: t.fgSubtle }}>{feature.desc}</p>
                        </div>
                        <Toggle checked={on} onChange={() => toggleFeature(feature.id)} label={feature.label} />
                      </div>

                      {/* Caption language and script, shown when captions is on */}
                      {feature.id === 'captions' && on && (
                        <div className="rounded-xl p-3.5 mt-2 space-y-3" style={{ background: t.muted, border: `1px solid ${t.border}` }}>
                          <div>
                            <span className="text-xs font-semibold block mb-1.5" style={{ color: t.fgMuted }}>Spoken language</span>
                            <div className="flex flex-wrap gap-1.5">
                              {CAPTION_LANGUAGES.map((l) => (
                                <Chip key={l.id} active={captionLanguage === l.id} onClick={() => setCaptionLanguage(l.id)} t={t}>{l.label}</Chip>
                              ))}
                            </div>
                            {captionLanguage === 'auto' && (
                              <p className="text-xs mt-2 leading-relaxed" style={{ color: t.fgSubtle }}>
                                Hindi and Marathi sound alike. For the best accuracy, pick the language yourself.
                              </p>
                            )}
                          </div>
                          {showScriptPicker && (
                            <div>
                              <span className="text-xs font-semibold block mb-1.5" style={{ color: t.fgMuted }}>
                                {captionLanguage === 'hi'
                                  ? 'Write Hindi captions in'
                                  : captionLanguage === 'mr'
                                    ? 'Write Marathi captions in'
                                    : 'Write Hindi or Marathi captions in'}
                              </span>
                              <div className="flex flex-wrap gap-1.5">
                                {CAPTION_SCRIPTS.map((s) => (
                                  <Chip key={s.id} active={captionScript === s.id} onClick={() => setCaptionScript(s.id)} t={t}>{s.label}</Chip>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Subtitle style and font, shown when subtitle_styles is on */}
                      {feature.id === 'subtitle_styles' && on && (
                        <div className="rounded-xl p-3.5 mt-2 space-y-3" style={{ background: t.muted, border: `1px solid ${t.border}` }}>
                          <div>
                            <span className="text-xs font-semibold block mb-1.5" style={{ color: t.fgMuted }}>Style</span>
                            <div className="flex flex-wrap gap-1.5">
                              {SUBTITLE_STYLES.map((s) => (
                                <Chip key={s} active={subtitleStyle === s} onClick={() => setSubtitleStyle(s)} t={t}>{s}</Chip>
                              ))}
                            </div>
                          </div>
                          <div>
                            <label htmlFor="subtitle-font" className="text-xs font-semibold block mb-1.5" style={{ color: t.fgMuted }}>Font</label>
                            <select
                              id="subtitle-font"
                              value={subtitleFont}
                              onChange={(e) => setSubtitleFont(e.target.value)}
                              className="w-full text-xs py-2 px-2.5 rounded-lg"
                              style={{ background: t.card, color: t.fg, border: `1px solid ${t.border}` }}
                            >
                              <optgroup label="Latin fonts">
                                {SUBTITLE_FONTS.filter((f) => !['noto-deva', 'mukta', 'tiro-deva'].includes(f)).map((f) => (
                                  <option key={f} value={f}>{f}</option>
                                ))}
                              </optgroup>
                              <optgroup label="Hindi / Marathi (Devanagari)">
                                <option value="noto-deva">noto-deva (recommended)</option>
                                <option value="mukta">mukta</option>
                                <option value="tiro-deva">tiro-deva (serif, Marathi)</option>
                              </optgroup>
                            </select>
                            {showDevanagariFontHint && (
                              <p className="text-xs mt-2 leading-relaxed" style={{ color: t.fgSubtle }}>
                                For Hindi or Marathi, pick a Devanagari font above. Otherwise Noto Sans Devanagari is used automatically.
                              </p>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </section>
            ))}

            {/* Sticky apply bar */}
            <div
              className="sticky bottom-4 rounded-2xl p-4 space-y-3"
              style={{ background: t.card, border: `1px solid ${t.border}`, boxShadow: t.shadowLg }}
            >
              <div className="flex items-center justify-between text-xs" style={{ color: t.fgMuted }}>
                <span>{enabledSteps.length === 0 ? 'No features selected' : `${enabledSteps.length} feature${enabledSteps.length === 1 ? '' : 's'} selected`}</span>
                <span style={{ color: t.fgSubtle }}>{file ? '' : 'Upload a video first'}</span>
              </div>
              <button
                onClick={handleApply}
                disabled={applyDisabled}
                className={`w-full flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-semibold text-white transition-all duration-150 hover:opacity-90 active:scale-[0.98] disabled:opacity-60 ${focusRing}`}
                style={{ background: 'linear-gradient(135deg, #6366F1, #8B5CF6)', boxShadow: '0 6px 20px rgba(99,102,241,0.35)' }}
              >
                {isBusy ? (
                  <>
                    <Spinner /> {statusLabel || 'Working...'}
                  </>
                ) : (
                  <>
                    <IconSparkles size={16} /> {status === 'done' ? 'Apply again' : 'Apply features'}
                  </>
                )}
              </button>
            </div>
          </aside>
        </main>
      </div>

      {/* Full-screen past-video preview */}
      {previewVideo && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-6"
          style={{ background: 'rgba(0,0,0,0.85)' }}
          onClick={() => setPreviewVideo(null)}
          role="dialog"
          aria-modal="true"
          aria-label="Video preview"
        >
          <video src={previewVideo.videoUrl} controls autoPlay className="max-w-full max-h-full rounded-lg" onClick={(e) => e.stopPropagation()} />
          <button
            onClick={() => setPreviewVideo(null)}
            className={`absolute top-6 right-6 w-10 h-10 rounded-full flex items-center justify-center text-white text-xl leading-none ${focusRing}`}
            style={{ background: 'rgba(255,255,255,0.15)', backdropFilter: 'blur(8px)' }}
            aria-label="Close preview"
          >
            ×
          </button>
          <p className="absolute bottom-6 left-1/2 -translate-x-1/2 max-w-2xl text-center text-sm px-4" style={{ color: 'rgba(255,255,255,0.8)' }} onClick={(e) => e.stopPropagation()}>
            {previewVideo.filename}
          </p>
        </div>
      )}
    </div>
  );
}