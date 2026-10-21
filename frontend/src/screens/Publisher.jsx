import { useState, useEffect, useMemo } from 'react';
import { useTheme } from '../theme/ThemeContext.jsx';
import Sidebar from '../shared/Sidebar.jsx';
import ThemeToggle from '../shared/ThemeToggle.jsx';
import AvatarMenu from '../shared/Avatar.jsx';
import Spinner from '../shared/Spinner.jsx';
import { part3, PART3_URL } from '../api.js';
import { IconSparkles } from '../icons/index.jsx';

const DISPLAY_FONT = "'Sora', 'Inter', system-ui, sans-serif";
const focusRing = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6366F1]';

// Only the 5 platforms actually wired up in part3-publisher/server.js.
// `field` controls which key in the request body carries the caption/title
// text -- server.js expects a different field name per platform.
// `fieldLabel` is display-only.
const PLATFORMS = [
  { id: 'youtube', label: 'YouTube', color: '#FF0000', mark: 'YT', field: 'title', fieldLabel: 'Title', needsAuth: true, authPath: '/auth/youtube' },
  { id: 'instagram', label: 'Instagram', color: '#E1306C', mark: 'IG', field: 'caption', fieldLabel: 'Caption', needsAuth: false },
  { id: 'facebook', label: 'Facebook', color: '#1877F2', mark: 'f', field: 'title', fieldLabel: 'Title', needsAuth: false },
  { id: 'threads', label: 'Threads', color: '#1F1F1F', mark: '@', field: 'text', fieldLabel: 'Post text', needsAuth: false },
  { id: 'linkedin', label: 'LinkedIn', color: '#0A66C2', mark: 'in', field: 'text', fieldLabel: 'Post text', needsAuth: true, authPath: '/auth/linkedin' },
];

const PLATFORM_BY_ID = Object.fromEntries(PLATFORMS.map((p) => [p.id, p]));

// Pulls a link out of a publish record's `result`, if the platform's route
// returned one. YouTube gives `url`; instagram/facebook/threads give an id
// you'd have to build a link from, so only youtube.result.url is clickable today.
function resultLink(record) {
  return record?.result?.url || null;
}

// Firestore serverTimestamp() comes back over JSON as either
// { _seconds, _nanoseconds } or an ISO string depending on the SDK/route.
// Normalize both to milliseconds.
function toMillis(ts) {
  if (!ts) return 0;
  if (typeof ts === 'string') return new Date(ts).getTime();
  if (typeof ts._seconds === 'number') return ts._seconds * 1000;
  return 0;
}

function formatTimestamp(ts) {
  const ms = toMillis(ts);
  return ms ? new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
}

// Last path segment, so history shows "clip.mp4" instead of a long URL/path.
function videoName(path) {
  if (!path || path === 'unknown') return 'Unknown video';
  const clean = path.split('?')[0];
  return decodeURIComponent(clean.split(/[\\/]/).pop() || clean);
}

// Groups flat publish records (one per platform per attempt) into one entry
// per video, holding the latest record for each platform it was sent to.
function groupHistoryByVideo(history) {
  const groups = new Map();

  for (const record of history) {
    const key = record.payload?.videoPath || 'unknown';
    if (!groups.has(key)) {
      groups.set(key, { videoPath: key, platforms: {}, latestAt: record.createdAt });
    }
    const group = groups.get(key);

    // Keep only the most recent record per platform.
    const existing = group.platforms[record.platform];
    if (!existing || toMillis(record.createdAt) >= toMillis(existing.createdAt)) {
      group.platforms[record.platform] = record;
    }
    if (toMillis(record.createdAt) > toMillis(group.latestAt)) {
      group.latestAt = record.createdAt;
    }
  }

  return Array.from(groups.values()).sort((a, b) => toMillis(b.latestAt) - toMillis(a.latestAt));
}

function PlatformMark({ platform, size = 36 }) {
  return (
    <span
      className="rounded-lg flex items-center justify-center text-white font-bold shrink-0"
      style={{ width: size, height: size, background: platform.color, fontSize: size * 0.34, border: '1px solid rgba(255,255,255,0.14)' }}
      aria-hidden="true"
    >
      {platform.mark}
    </span>
  );
}

function StatusBadge({ status, t }) {
  const map = {
    done: { label: 'Published', bg: 'rgba(34,197,94,0.14)', fg: '#16A34A', glyph: '✓' },
    failed: { label: 'Failed', bg: 'rgba(239,68,68,0.12)', fg: '#EF4444', glyph: '!' },
    publishing: { label: 'Publishing', bg: t.muted, fg: t.fgMuted, glyph: '…' },
  };
  const s = map[status] || map.publishing;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full shrink-0" style={{ background: s.bg, color: s.fg }}>
      <span aria-hidden="true">{s.glyph}</span> {s.label}
    </span>
  );
}

function HistoryEmpty({ t }) {
  return (
    <div className="rounded-2xl flex flex-col items-center text-center px-6 py-12" style={{ border: `1.5px dashed ${t.border}`, background: t.card }}>
      <svg viewBox="0 0 200 110" className="w-40 mb-4" aria-hidden="true">
        <defs>
          <linearGradient id="pub-g" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#6366F1" />
            <stop offset="1" stopColor="#8B5CF6" />
          </linearGradient>
        </defs>
        <rect x="20" y="28" width="46" height="62" rx="9" fill="url(#pub-g)" />
        <path d="M37 50v18l15-9z" fill="#fff" />
        {[18, 42, 66, 90].map((y, i) => (
          <g key={y}>
            <path d={`M70 59 C100 59, 110 ${y}, 138 ${y}`} stroke={t.border} strokeWidth="2" fill="none" strokeDasharray="3 4" />
            <circle cx="150" cy={y} r="8" fill={t.muted} stroke={t.border} />
            <circle cx="150" cy={y} r="3.5" fill={['#FF4D4D', '#E1306C', '#4C8DFF', '#0A66C2'][i]} />
          </g>
        ))}
      </svg>
      <p className="text-sm font-bold mb-1" style={{ color: t.fg, fontFamily: DISPLAY_FONT }}>Nothing published yet</p>
      <p className="text-xs max-w-[220px]" style={{ color: t.fgSubtle }}>Your posts and where they went will show up here after your first publish.</p>
    </div>
  );
}

export default function PublisherScreen({ onNavigate, onLogout, incomingVideoUrl }) {
  const { t } = useTheme();

  const [videoPath, setVideoPath] = useState(incomingVideoUrl || '');
  const [caption, setCaption] = useState('');
  const [selected, setSelected] = useState(new Set());
  const [results, setResults] = useState({}); // { platformId: { status, error? } } -- this run only
  const [isPublishing, setIsPublishing] = useState(false);

  // Full persisted publish history from Firestore via GET /publishes. This is
  // what actually answers "which video went to which platforms", rather than
  // trusting in-memory state from the current session.
  const [history, setHistory] = useState([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [historyError, setHistoryError] = useState(null);

  const videoGroups = useMemo(() => groupHistoryByVideo(history), [history]);

  async function loadHistory() {
    try {
      const publishes = await part3.listPublishes();
      setHistory(publishes);
      setHistoryError(null);
    } catch (err) {
      console.error('Failed to load publish history:', err);
      setHistoryError(err.message);
    } finally {
      setLoadingHistory(false);
    }
  }

  useEffect(() => {
    loadHistory();
  }, []);

  function toggle(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  const allSelected = selected.size === PLATFORMS.length;
  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(PLATFORMS.map((p) => p.id)));
  }

  // Publishes to the given platform ids in parallel. `keepPrevious` leaves
  // earlier per-platform results in place (used by "Retry failed" so the
  // platforms that already succeeded keep their badge).
  async function runPublish(ids, keepPrevious = false) {
    setIsPublishing(true);
    setResults((prev) => (keepPrevious ? prev : {}));

    await Promise.all(
      ids.map(async (platformId) => {
        setResults((prev) => ({ ...prev, [platformId]: { status: 'publishing' } }));
        try {
          const platform = PLATFORMS.find((p) => p.id === platformId);
          const payload = { videoPath: videoPath.trim(), [platform.field]: caption };

          const response = await part3.publish(platformId, payload);
          setResults((prev) => ({ ...prev, [platformId]: { status: 'done', publishId: response.publishId } }));
        } catch (err) {
          setResults((prev) => ({ ...prev, [platformId]: { status: 'failed', error: err.message } }));
        }
      })
    );

    setIsPublishing(false);
    // Re-fetch history from the backend rather than assembling records
    // locally: each record was already written to Firestore before
    // /publish/{platform} responded, so this also confirms it was stored.
    loadHistory();
  }

  function handlePublish() {
    if (!videoPath.trim() || selected.size === 0) return;
    runPublish([...selected]);
  }

  function retryFailed() {
    const failedIds = Object.entries(results).filter(([, r]) => r.status === 'failed').map(([id]) => id);
    if (!videoPath.trim() || failedIds.length === 0) return;
    runPublish(failedIds, true);
  }

  // Pre-fills the form from a history card so a video can go to more platforms.
  function publishAgain(path) {
    setVideoPath(path === 'unknown' ? '' : path);
    setResults({});
    setSelected(new Set());
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  const resultList = Object.values(results);
  const doneCount = resultList.filter((r) => r.status === 'done').length;
  const failedCount = resultList.filter((r) => r.status === 'failed').length;
  const finishedRun = resultList.length > 0 && !isPublishing;

  const canPreview = /^(https?:|blob:)/.test(videoPath.trim());
  const publishDisabled = isPublishing || !videoPath.trim() || selected.size === 0;
  const disabledReason = !videoPath.trim() ? 'Add a video to publish' : selected.size === 0 ? 'Choose at least one platform' : '';

  const cardStyle = { background: t.card, border: `1px solid ${t.border}`, boxShadow: t.shadowSm };

  return (
    <div className="flex min-h-screen transition-colors duration-200" style={{ background: t.bg }}>
      <Sidebar screen="publisher" onNavigate={onNavigate} onLogout={onLogout} />
      <div className="flex-1 flex flex-col min-w-0">
        <header
          className="flex items-center justify-between px-8 py-4 sticky top-0 z-20 transition-colors duration-200"
          style={{ background: t.headerBg, backdropFilter: 'blur(12px)', borderBottom: `1px solid ${t.border}` }}
        >
          <div>
            <h1 className="text-lg font-bold" style={{ color: t.fg, fontFamily: DISPLAY_FONT }}>Publisher</h1>
            <p className="text-xs" style={{ color: t.fgSubtle }}>Post one video to every platform in a single step</p>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <AvatarMenu onNavigate={onNavigate} onLogout={onLogout} />
          </div>
        </header>

        <main className="flex-1 p-6 lg:p-8 grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_420px] gap-8 items-start">
          {/* ================= Composer ================= */}
          <div className="space-y-5 min-w-0 max-w-3xl w-full">
            {/* 1. Video */}
            <section className="rounded-2xl p-5" style={cardStyle} aria-label="Video">
              <div className="flex items-center justify-between mb-3">
                <label htmlFor="video-path" className="text-sm font-bold" style={{ color: t.fg, fontFamily: DISPLAY_FONT }}>Video</label>
                {incomingVideoUrl && videoPath === incomingVideoUrl && (
                  <span className="text-xs font-semibold px-2.5 py-1 rounded-full" style={{ background: t.pillBg, color: t.pillFg, border: `1px solid ${t.pillBorder}` }}>
                    Sent from the editor
                  </span>
                )}
              </div>
              <div className="flex gap-4">
                {canPreview && (
                  <video src={videoPath.trim()} controls muted className="w-24 sm:w-28 rounded-xl bg-black shrink-0 object-contain" style={{ aspectRatio: '9/16', border: `1px solid ${t.border}` }} />
                )}
                <div className="flex-1 min-w-0">
                  <input
                    id="video-path"
                    type="text"
                    value={videoPath}
                    onChange={(e) => setVideoPath(e.target.value)}
                    placeholder="Paste a video link or path"
                    className="w-full text-sm"
                  />
                  <p className="text-xs mt-2 leading-relaxed" style={{ color: t.fgSubtle }}>
                    Videos you finish in the editor are filled in here automatically. You can also paste a link to any file your server can reach.
                  </p>
                </div>
              </div>
            </section>

            {/* 2. Platforms */}
            <section className="rounded-2xl p-5" style={cardStyle} aria-label="Platforms">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-sm font-bold" style={{ color: t.fg, fontFamily: DISPLAY_FONT }}>Where should it go?</h2>
                <button onClick={toggleAll} className={`text-xs font-semibold hover:underline rounded ${focusRing}`} style={{ color: t.pillFg }}>
                  {allSelected ? 'Clear all' : 'Select all'}
                </button>
              </div>

              <div className="space-y-2.5">
                {PLATFORMS.map((platform) => {
                  const on = selected.has(platform.id);
                  const r = results[platform.id];
                  return (
                    <div key={platform.id}>
                      <div
                        className="rounded-xl flex items-center gap-3 p-3 transition-all"
                        style={{
                          background: on ? t.pillBg : t.card,
                          border: `1px solid ${on ? '#6366F1' : t.border}`,
                          boxShadow: on ? '0 0 0 3px rgba(99,102,241,0.12)' : 'none',
                        }}
                      >
                        <button
                          type="button"
                          role="checkbox"
                          aria-checked={on}
                          aria-label={`Publish to ${platform.label}`}
                          onClick={() => toggle(platform.id)}
                          className={`flex items-center gap-3 flex-1 min-w-0 text-left rounded-lg ${focusRing}`}
                        >
                          <PlatformMark platform={platform} />
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm font-semibold" style={{ color: t.fg }}>{platform.label}</span>
                            <span className="block text-xs" style={{ color: t.fgSubtle }}>Uses your text as the {platform.fieldLabel.toLowerCase()}</span>
                          </span>
                          <span
                            className="w-5 h-5 rounded-md flex items-center justify-center text-white text-xs shrink-0 transition-all"
                            style={{ background: on ? '#6366F1' : 'transparent', border: `1.5px solid ${on ? '#6366F1' : t.border}` }}
                            aria-hidden="true"
                          >
                            {on ? '✓' : ''}
                          </span>
                        </button>

                        {platform.needsAuth && (
                          <a
                            href={`${PART3_URL}${platform.authPath}`}
                            target="_blank"
                            rel="noreferrer"
                            className={`text-xs font-semibold px-2.5 py-1.5 rounded-lg transition-all hover:opacity-80 shrink-0 ${focusRing}`}
                            style={{ background: t.muted, color: t.fgMuted, border: `1px solid ${t.border}` }}
                          >
                            Connect account
                          </a>
                        )}

                        {r && <StatusBadge status={r.status} t={t} />}
                      </div>
                      {r?.status === 'failed' && r.error && (
                        <p className="text-xs mt-1.5 ml-1 leading-relaxed" style={{ color: '#EF4444' }}>{r.error}</p>
                      )}
                    </div>
                  );
                })}
              </div>
              <p className="text-xs mt-3" style={{ color: t.fgSubtle }}>YouTube and LinkedIn need a one-time connection before the first post.</p>
            </section>

            {/* 3. Caption */}
            <section className="rounded-2xl p-5" style={cardStyle} aria-label="Caption">
              <div className="flex items-center justify-between mb-3">
                <label htmlFor="caption" className="text-sm font-bold" style={{ color: t.fg, fontFamily: DISPLAY_FONT }}>Caption</label>
                <span className="text-xs font-mono" style={{ color: t.fgSubtle }}>{caption.length} characters</span>
              </div>
              <textarea
                id="caption"
                rows={4}
                value={caption}
                onChange={(e) => setCaption(e.target.value)}
                placeholder="Write a caption or title for your video"
                className="w-full resize-none text-sm"
              />
              <p className="text-xs mt-2 leading-relaxed" style={{ color: t.fgSubtle }}>
                The same text is sent to every selected platform: as a title on YouTube and Facebook, a caption on Instagram, and post text on Threads and LinkedIn.
              </p>
            </section>

            {/* Result summary after a run */}
            {finishedRun && (
              <div
                role="status"
                className="rounded-2xl px-5 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                style={{
                  background: failedCount > 0 ? 'rgba(245,158,11,0.12)' : 'rgba(34,197,94,0.12)',
                  border: `1px solid ${failedCount > 0 ? 'rgba(245,158,11,0.35)' : 'rgba(34,197,94,0.35)'}`,
                }}
              >
                <p className="text-sm font-semibold" style={{ color: t.fg }}>
                  {failedCount === 0
                    ? `Published to ${doneCount} platform${doneCount === 1 ? '' : 's'}.`
                    : `Published to ${doneCount}, ${failedCount} failed.`}
                  <span className="font-normal" style={{ color: t.fgMuted }}> {failedCount === 0 ? 'It’s saved in your history.' : 'Check the message under each failed platform.'}</span>
                </p>
                {failedCount > 0 && (
                  <button
                    onClick={retryFailed}
                    className={`text-xs font-semibold px-4 py-2 rounded-lg text-white shrink-0 transition-all hover:opacity-90 ${focusRing}`}
                    style={{ background: '#D97706' }}
                  >
                    Retry failed
                  </button>
                )}
              </div>
            )}

            {/* Publish bar */}
            <div className="sticky bottom-4 rounded-2xl p-4 space-y-2.5" style={{ background: t.card, border: `1px solid ${t.border}`, boxShadow: t.shadowLg }}>
              <button
                onClick={handlePublish}
                disabled={publishDisabled}
                className={`w-full flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-semibold text-white transition-all duration-150 hover:opacity-90 active:scale-[0.98] disabled:opacity-60 ${focusRing}`}
                style={{ background: 'linear-gradient(135deg, #6366F1, #8B5CF6)', boxShadow: '0 6px 20px rgba(99,102,241,0.35)' }}
              >
                {isPublishing ? (
                  <>
                    <Spinner /> Publishing...
                  </>
                ) : (
                  <>
                    <IconSparkles size={16} /> Publish to {selected.size || ''} platform{selected.size === 1 ? '' : 's'}
                  </>
                )}
              </button>
              {disabledReason && !isPublishing && (
                <p className="text-xs text-center" style={{ color: t.fgSubtle }}>{disabledReason}</p>
              )}
            </div>
          </div>

          {/* ================= History ================= */}
          <aside className="xl:sticky xl:top-24 min-w-0" aria-label="Publish history">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-base font-bold" style={{ color: t.fg, fontFamily: DISPLAY_FONT }}>
                Publish history {videoGroups.length > 0 && <span className="text-sm font-normal" style={{ color: t.fgSubtle }}>({videoGroups.length})</span>}
              </h2>
              <button
                onClick={loadHistory}
                className={`text-xs font-semibold px-3 py-1.5 rounded-lg transition-all hover:opacity-80 ${focusRing}`}
                style={{ background: t.pillBg, color: t.pillFg }}
              >
                Refresh
              </button>
            </div>

            <div className="space-y-3 xl:max-h-[calc(100vh-10rem)] xl:overflow-y-auto xl:pr-1">
              {loadingHistory && videoGroups.length === 0 && (
                <div className="flex items-center justify-center gap-2 py-10" style={{ color: t.fgSubtle }}>
                  <Spinner /> <span className="text-sm">Loading your history...</span>
                </div>
              )}

              {historyError && !loadingHistory && (
                <div role="alert" className="rounded-xl px-4 py-3 text-sm" style={{ color: '#EF4444', background: 'rgba(239,68,68,0.1)' }}>
                  Couldn’t load your history: {historyError}
                </div>
              )}

              {!loadingHistory && !historyError && videoGroups.length === 0 && <HistoryEmpty t={t} />}

              {videoGroups.map((group) => {
                const platformRecords = PLATFORMS.map((p) => group.platforms[p.id]).filter(Boolean);
                return (
                  <div key={group.videoPath} className="rounded-xl p-4" style={cardStyle}>
                    <div className="flex items-start justify-between gap-3 mb-3">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold truncate" style={{ color: t.fg }} title={group.videoPath}>{videoName(group.videoPath)}</p>
                        <p className="text-xs mt-0.5" style={{ color: t.fgSubtle }}>{formatTimestamp(group.latestAt)}</p>
                      </div>
                      <button
                        onClick={() => publishAgain(group.videoPath)}
                        className={`text-xs font-semibold px-2.5 py-1.5 rounded-lg shrink-0 transition-all hover:opacity-80 ${focusRing}`}
                        style={{ background: t.muted, color: t.fgMuted, border: `1px solid ${t.border}` }}
                      >
                        Publish again
                      </button>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      {platformRecords.map((record) => {
                        const platform = PLATFORM_BY_ID[record.platform];
                        const link = resultLink(record);
                        const Badge = link ? 'a' : 'span';
                        const failed = record.status === 'failed';
                        const done = record.status === 'done';
                        return (
                          <Badge
                            key={record.platform}
                            {...(link ? { href: link, target: '_blank', rel: 'noreferrer' } : {})}
                            title={failed ? record.error : link ? `Open on ${platform?.label || record.platform}` : undefined}
                            className={`flex items-center gap-1.5 text-xs font-medium pl-2 pr-2.5 py-1 rounded-full transition-all ${link ? `hover:opacity-80 ${focusRing}` : ''}`}
                            style={{
                              background: done ? t.pillBg : failed ? 'rgba(239,68,68,0.12)' : t.muted,
                              color: done ? t.pillFg : failed ? '#EF4444' : t.fgMuted,
                              cursor: link ? 'pointer' : 'default',
                            }}
                          >
                            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: platform?.color || t.fgSubtle }} />
                            {platform?.label || record.platform}
                            {record.status === 'publishing' && ' · Publishing'}
                            {failed && ' · Failed'}
                            {link && <span aria-hidden="true"> ↗</span>}
                          </Badge>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </aside>
        </main>
      </div>
    </div>
  );
}