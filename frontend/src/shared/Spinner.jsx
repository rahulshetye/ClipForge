// Smooth ring spinner. Inherits the surrounding text color (currentColor), so
// it works on buttons, dark overlays and cards without extra styling.
//
// size:  pixel size (default 18, same as before)
// label: text for screen readers. Pass label={null} when the spinner sits
//        next to visible text like "Generating..." so it isn't read twice.
export default function Spinner({ size = 18, label = 'Loading' }) {
  const a11y = label ? { role: 'status', 'aria-label': label } : { 'aria-hidden': true };
  return (
    <svg
      {...a11y}
      className="animate-spin motion-reduce:animate-[spin_2.4s_linear_infinite] shrink-0"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
    >
      <circle cx="12" cy="12" r="9" opacity="0.25" />
      <path d="M21 12a9 9 0 00-9-9" />
    </svg>
  );
}