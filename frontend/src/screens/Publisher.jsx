import { useState, useEffect, useMemo } from 'react';
import { useTheme } from '../theme/ThemeContext.jsx';
import Sidebar from '../shared/Sidebar.jsx';
import ThemeToggle from '../shared/ThemeToggle.jsx';
import Spinner from '../shared/Spinner.jsx';
import { part3, PART3_URL } from '../api.js';
import { IconSparkles } from '../icons/index.jsx';

// Only the 5 platforms actually wired up in part3-publisher/server.js.
// `field` controls which key in the request body carries the caption/title text --
// server.js expects a different field name per platform.
const PLATFORMS = [
  { id: 'youtube', label: 'YouTube', color: '#FF0000', field: 'title', needsAuth: true, authPath: '/auth/youtube' },
  { id: 'instagram', label: 'Instagram', color: '#E1306C', field: 'caption', needsAuth: false },
  { id: 'facebook', label: 'Facebook', color: '#1877F2', field: 'title', needsAuth: false },
  { id: 'threads', label: 'Threads', color: '#000000', field: 'text', needsAuth: false },
  { id: 'linkedin', label: 'LinkedIn', color: '#0A66C2', field: 'text', needsAuth: true, authPath: '/auth/linkedin' },
];

const PLATFORM_BY_ID = Object.fromEntries(PLATFORMS.map((p) => [p.id, p]));

// Pulls a link out of a publish record's `result`, if the platform's route
// returned one -- youtube gives `url`, instagram/facebook/threads give an
// id you'd have to construct a link from manually, so this only surfaces
// what's actually clickable today (youtube.result.url).
function resultLink(record) {
  return record?.result?.url || null;
}

// Firestore serverTimestamp() comes back over JSON as either
// { _seconds, _nanoseconds } or an ISO string depending on the SDK/route --
// normalize both to milliseconds for sorting/comparison.
function toMillis(ts) {
  if (!ts) return 0;
  if (typeof ts === 'string') return new Date(ts).getTime();
  if (typeof ts._seconds === 'number') return ts._seconds * 1000;
  return 0;
}

function formatTimestamp(ts) {
  const ms = toMillis(ts);
  return ms ? new Date(ms).toLocaleString() : '';
}

// Groups flat publish records (one per platform per attempt) into one entry
// per video, each holding the latest record for every platform it was sent
// to -- so "published to Threads, Instagram, YouTube" reads as one line per
// video instead of one log row per platform per attempt.
function groupHistoryByVideo(history) {
  const groups = new Map();

  for (const record of history) {
    const key = record.payload?.videoPath || 'unknown';
    if (!groups.has(key)) {
      groups.set(key, { videoPath: key, platforms: {}, latestAt: record.createdAt });
    }
    const group = groups.get(key);

    // Keep only the most recent record per platform, in case the same
    // video was published to the same platform more than once.
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

export default function PublisherScreen({ onNavigate, onLogout, incomingVideoUrl }) {
  const { t } = useTheme();
  const [videoPath, setVideoPath] = useState(incomingVideoUrl || '');
  const [caption, setCaption] = useState('');
  const [selected, setSelected] = useState(new Set());
  const [results, setResults] = useState({}); // { platformId: { status, error? } } -- this run only
  const [isPublishing, setIsPublishing] = useState(false);

  // Full persisted publish history, straight from Firestore via GET /publishes --
  // this is what actually answers "which video went to which platforms" instead
  // of trusting in-memory state from the current session.
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

  async function handlePublish() {
    if (!videoPath.trim() || selected.size === 0) return;
    setIsPublishing(true);
    setResults({});

    await Promise.all(
      [...selected].map(async (platformId) => {
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
    // locally -- this is the actual persisted state (each record was
    // already written to Firestore before /publish/{platform} responded),
    // so this is also the confirmation that it really did get stored.
    loadHistory();
  }

  return (
    <div className="flex min-h-screen transition-colors duration-200" style={{ background: t.bg }}>
      <Sidebar screen="publisher" onNavigate={onNavigate} onLogout={onLogout} />
      <div className="flex-1 flex flex-col min-w-0">
        <header
          className="flex items-center justify-between px-8 py-4 sticky top-0 z-10 transition-colors duration-200"
          style={{ background: t.headerBg, backdropFilter: 'blur(12px)', borderBottom: `1px solid ${t.border}` }}
        >
          <div>
            <h1 className="text-lg font-bold" style={{ color: t.fg }}>Publisher</h1>
            <p className="text-xs" style={{ color: t.fgSubtle }}>Publish your video across platforms, in one go</p>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <div className="w-9 h-9 rounded-full bg-gradient-to-br from-[#6366F1] to-[#8B5CF6] flex items-center justify-center text-white text-sm font-bold shadow-md">JD</div>
          </div>
        </header>

        <main className="flex-1 p-8 max-w-2xl mx-auto w-full space-y-6">
          <div className="rounded-2xl p-5" style={{ background: t.card, border: `1px solid ${t.border}`, boxShadow: t.shadowSm }}>
            <label className="text-xs font-semibold block mb-2" style={{ color: t.fgMuted }}>Video path</label>
            <input
              type="text"
              value={videoPath}
              onChange={(e) => setVideoPath(e.target.value)}
              placeholder="/path/to/your/video.mp4 (or auto-filled from Editor)"
              className="w-full text-sm"
            />
          </div>

          <div className="rounded-2xl p-5 space-y-1" style={{ background: t.card, border: `1px solid ${t.border}`, boxShadow: t.shadowSm }}>
            <h2 className="text-sm font-semibold mb-3" style={{ color: t.fg }}>Platforms</h2>
            {PLATFORMS.map((platform) => (
              <div key={platform.id} className="flex items-center gap-3 py-2.5" style={{ borderBottom: `1px solid ${t.border}` }}>
                <input
                  type="checkbox"
                  checked={selected.has(platform.id)}
                  onChange={() => toggle(platform.id)}
                  className="w-4 h-4 shrink-0"
                />
                <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: platform.color }} />
                <span className="text-sm font-medium flex-1" style={{ color: t.fg }}>{platform.label}</span>

                {platform.needsAuth && (
                  <a
                    href={`${PART3_URL}${platform.authPath}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs font-medium px-2 py-1 rounded-lg transition-all hover:opacity-80"
                    style={{ background: t.pillBg, color: t.pillFg }}
                  >
                    Connect
                  </a>
                )}

                {results[platform.id] && (
                  <span
                    className="text-xs font-mono px-2 py-0.5 rounded-full"
                    style={{
                      background:
                        results[platform.id].status === 'done' ? t.pillBg
                        : results[platform.id].status === 'failed' ? 'rgba(239,68,68,0.12)'
                        : t.muted,
                      color:
                        results[platform.id].status === 'done' ? t.pillFg
                        : results[platform.id].status === 'failed' ? '#EF4444'
                        : t.fgMuted,
                    }}
                    title={results[platform.id].error}
                  >
                    {results[platform.id].status === 'publishing' && 'Publishing...'}
                    {results[platform.id].status === 'done' && 'Published'}
                    {results[platform.id].status === 'failed' && 'Failed'}
                  </span>
                )}
              </div>
            ))}
          </div>

          <div className="rounded-2xl p-5" style={{ background: t.card, border: `1px solid ${t.border}`, boxShadow: t.shadowSm }}>
            <label className="text-xs font-semibold block mb-2" style={{ color: t.fgMuted }}>
              Caption / title (used for all selected platforms)
            </label>
            <textarea
              rows={3}
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              placeholder="Write a caption or title..."
              className="w-full resize-none text-sm"
            />
          </div>

          <button
            onClick={handlePublish}
            disabled={isPublishing || !videoPath.trim() || selected.size === 0}
            className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-semibold text-white transition-all duration-150 hover:opacity-90 active:scale-[0.98] disabled:opacity-60"
            style={{ background: 'linear-gradient(135deg, #6366F1, #8B5CF6)', boxShadow: '0 4px 16px rgba(99,102,241,0.3)' }}
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

          {/* Publish history -- one card per video, grouped from users/{uid}/publishes
              via GET /publishes, showing every platform that video went to (and its
              status) as badges inside the same card instead of a flat per-platform log. */}
          <div className="pt-2">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold" style={{ color: t.fg }}>Publish History</h2>
              <button
                onClick={loadHistory}
                className="text-xs font-medium px-2.5 py-1 rounded-lg transition-all hover:opacity-80"
                style={{ background: t.pillBg, color: t.pillFg }}
              >
                Refresh
              </button>
            </div>

            {loadingHistory && videoGroups.length === 0 && (
              <div className="flex items-center justify-center gap-2 py-8" style={{ color: t.fgSubtle }}>
                <Spinner /> <span className="text-sm">Loading publish history...</span>
              </div>
            )}

            {historyError && !loadingHistory && (
              <p className="text-sm" style={{ color: '#EF4444' }}>{historyError}</p>
            )}

            {!loadingHistory && !historyError && videoGroups.length === 0 && (
              <p className="text-sm" style={{ color: t.fgSubtle }}>Nothing published yet.</p>
            )}

            {videoGroups.length > 0 && (
              <div className="space-y-3">
                {videoGroups.map((group) => {
                  const platformRecords = PLATFORMS
                    .map((p) => group.platforms[p.id])
                    .filter(Boolean);

                  return (
                    <div
                      key={group.videoPath}
                      className="rounded-xl p-4"
                      style={{ background: t.card, border: `1px solid ${t.border}`, boxShadow: t.shadowSm }}
                    >
                      <div className="flex items-center justify-between gap-3 mb-3">
                        <p className="text-sm font-semibold truncate" style={{ color: t.fg }}>
                          {group.videoPath}
                        </p>
                        <span className="text-xs shrink-0" style={{ color: t.fgSubtle }}>
                          {formatTimestamp(group.latestAt)}
                        </span>
                      </div>

                      <div className="flex flex-wrap gap-2">
                        {platformRecords.map((record) => {
                          const platform = PLATFORM_BY_ID[record.platform];
                          const link = resultLink(record);
                          const Badge = link ? 'a' : 'span';
                          return (
                            <Badge
                              key={record.platform}
                              {...(link ? { href: link, target: '_blank', rel: 'noreferrer' } : {})}
                              title={record.status === 'failed' ? record.error : undefined}
                              className="flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full transition-all"
                              style={{
                                background:
                                  record.status === 'done' ? t.pillBg
                                  : record.status === 'failed' ? 'rgba(239,68,68,0.12)'
                                  : t.muted,
                                color:
                                  record.status === 'done' ? t.pillFg
                                  : record.status === 'failed' ? '#EF4444'
                                  : t.fgMuted,
                                cursor: link ? 'pointer' : 'default',
                              }}
                            >
                              <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: platform?.color || t.fgSubtle }} />
                              {platform?.label || record.platform}
                              {record.status === 'publishing' && ' · Publishing...'}
                              {record.status === 'failed' && ' · Failed'}
                            </Badge>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}