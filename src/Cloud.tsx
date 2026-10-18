/** WhiteMood's original cloud character, drawn with native SVG paths. */
export default function Cloud({ className = '', face = true }: { className?: string; face?: boolean }) {
  return <svg className={`cloud-character ${className}`} viewBox="0 0 280 190" fill="none" aria-hidden="true">
    <ellipse className="cloud-shadow" cx="143" cy="173" rx="70" ry="7" />
    <g className="cloud-body">
      <path className="cloud-silhouette" d="M76 145c-29 0-49-17-49-41 0-22 17-40 39-42 5-24 28-40 53-34 15-20 48-19 63 4 24-1 43 16 46 39 20 4 34 19 34 37 0 23-18 37-43 37H76Z" />
      <path className="cloud-highlight" d="M77 60c8-17 26-25 43-20M130 31c12-8 27-6 36 4" />
      {face && <g className="cloud-face">
        <ellipse className="cloud-eye" cx="124" cy="101" rx="3.2" ry="4.1" />
        <ellipse className="cloud-eye" cx="160" cy="101" rx="3.2" ry="4.1" />
        <path className="cloud-smile" d="M135 113c4 5 10 5 14 0" />
      </g>}
    </g>
  </svg>;
}
