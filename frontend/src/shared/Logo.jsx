import { IconVideo } from '../icons/index.jsx';

export default function Logo({ size = 'md' }) {
  const sizes = { sm: 'text-lg', md: 'text-xl', lg: 'text-2xl' };
  const iconSizes = { sm: 28, md: 32, lg: 40 };
  return (
    <div className="flex items-center gap-2.5">
      <div
        style={{ width: iconSizes[size], height: iconSizes[size] }}
        className="rounded-xl bg-gradient-to-br from-[#6366F1] to-[#8B5CF6] flex items-center justify-center shadow-lg"
      >
        <IconVideo size={iconSizes[size] * 0.55} className="text-white" />
      </div>
      <span
        className={`font-bold ${sizes[size]} tracking-tight`}
        style={{ background: 'linear-gradient(135deg, #6366F1, #8B5CF6)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}
      >
        Velo<span style={{ WebkitTextFillColor: '#06B6D4' }}>AI</span>
      </span>
    </div>
  );
}
