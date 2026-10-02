import type { AVATAR_ACCESSORIES } from "@yo/contracts";
import type { ShapeGeometry } from "./shapes";

export type AccessoryId = (typeof AVATAR_ACCESSORIES)[number];

const INK = "#1D1E22";
const INK_HI = "#3A3C44";
const WHITE = "#F7F7F4";
const LINE = "rgba(0,0,0,0.14)";

/** Hats are designed for a 70-unit-wide head with their base at y=0 and drawn upward. */
function Hat({ g, children }: { g: ShapeGeometry; children: React.ReactNode }) {
  const s = g.hat.w / 70;
  return <g transform={`translate(${g.hat.x} ${g.hat.y}) scale(${s})`}>{children}</g>;
}

function Beanie() {
  return (
    <g>
      <path d="M-33 3C-34 -24 34 -24 33 3Z" fill="#F26B3A" />
      <path
        d="M-20 -16C-12 -21 -4 -22.5 3 -22.5"
        stroke="rgba(255,255,255,0.35)"
        strokeWidth={2.4}
        fill="none"
        strokeLinecap="round"
      />
      <rect x={-37} y={-5} width={74} height={13} rx={6.5} fill="#D9531F" />
      {[-28, -20, -12, -4, 4, 12, 20, 28].map((x) => (
        <path key={x} d={`M${x} -2.5V5.5`} stroke={LINE} strokeWidth={2} strokeLinecap="round" />
      ))}
      <circle cx={0} cy={-25} r={7.5} fill="#F7F7F4" />
      <circle cx={-2.2} cy={-27.2} r={2.4} fill="#fff" />
    </g>
  );
}

function Cap() {
  return (
    <g>
      <path d="M-32 3C-33 -24 33 -24 32 3Z" fill={WHITE} />
      <path d="M0 -21V2" stroke={LINE} strokeWidth={1.6} />
      <path
        d="M-16 -17C-19 -9 -20 -3 -20 2M16 -17C19 -9 20 -3 20 2"
        stroke={LINE}
        strokeWidth={1.4}
        fill="none"
      />
      <circle cx={0} cy={-21} r={3} fill="#1E3A5F" />
      <path d="M-37 2C-20 13 20 13 37 2C20 6.5 -20 6.5 -37 2Z" fill="#1E3A5F" />
      <path
        d="M-33 2.2C-18 5.5 18 5.5 33 2.2"
        stroke="#1E3A5F"
        strokeWidth={3.2}
        strokeLinecap="round"
        fill="none"
      />
    </g>
  );
}

function Chef() {
  return (
    <g>
      <circle cx={-17} cy={-20} r={13} fill={WHITE} />
      <circle cx={17} cy={-20} r={13} fill={WHITE} />
      <circle cx={0} cy={-28} r={16} fill={WHITE} />
      <rect x={-25} y={-17} width={50} height={20} rx={4} fill={WHITE} />
      <path d="M-10 -16V-4M0 -16V-4M10 -16V-4" stroke={LINE} strokeWidth={1.6} strokeLinecap="round" />
      <rect x={-27} y={-3} width={54} height={8} rx={3} fill="#E7E7E2" />
    </g>
  );
}

function Crown() {
  return (
    <g transform="translate(0 2) scale(0.9)">
      <path
        d="M-27 2L-29.5 -22L-14 -9L0 -28L14 -9L29.5 -22L27 2Z"
        fill="#FFC53D"
        stroke="#B7791F"
        strokeWidth={2.2}
        strokeLinejoin="round"
      />
      <path d="M-27 -2H27" stroke="#B7791F" strokeWidth={2} />
      <circle cx={0} cy={-28} r={3.6} fill="#EF4444" />
      <circle cx={-29.5} cy={-22} r={3} fill="#3B82F6" />
      <circle cx={29.5} cy={-22} r={3} fill="#3B82F6" />
      <circle cx={0} cy={-8} r={3.2} fill="#EF4444" />
    </g>
  );
}

function Antenna() {
  return (
    <g>
      <path d="M-7 3C-7 -3 7 -3 7 3Z" fill={INK} />
      <path d="M0 0V-19" stroke="#9A9DA6" strokeWidth={3} strokeLinecap="round" />
      <g className="yo-av-antenna">
        <circle cx={0} cy={-23} r={6} fill="#EF4444" />
        <circle cx={-2} cy={-25} r={1.8} fill="#fff" opacity={0.85} />
      </g>
    </g>
  );
}

function Headset({ g }: { g: ShapeGeometry }) {
  const { l, r, y } = g.ears;
  const top = g.top - 7;
  return (
    <g>
      <path
        d={`M${l + 1} ${y - 6}C${l - 2} ${top}, ${r + 2} ${top}, ${r - 1} ${y - 6}`}
        stroke={INK}
        strokeWidth={4.2}
        fill="none"
        strokeLinecap="round"
      />
      <path
        d={`M${l + 5} ${y - 16}C${l + 8} ${top + 6}, ${r - 8} ${top + 6}, ${r - 5} ${y - 16}`}
        stroke={INK_HI}
        strokeWidth={1.2}
        fill="none"
        strokeLinecap="round"
        opacity={0.8}
      />
      <rect x={l - 5.5} y={y - 10} width={11} height={20} rx={5} fill={INK} />
      <rect x={r - 5.5} y={y - 10} width={11} height={20} rx={5} fill={INK} />
      <rect x={l - 2.5} y={y - 6} width={3} height={12} rx={1.5} fill={INK_HI} />
      <rect x={r - 0.5} y={y - 6} width={3} height={12} rx={1.5} fill={INK_HI} />
      <g className="yo-av-mic" style={{ transformBox: "view-box", transformOrigin: `${l + 2}px ${y + 8}px` }}>
        <path
          d={`M${l + 2} ${y + 8}C${l + 4} ${y + 20}, ${g.face.x - 16} ${g.face.y + 21}, ${g.face.x - 8} ${g.face.y + 19}`}
          stroke={INK}
          strokeWidth={2.6}
          fill="none"
          strokeLinecap="round"
        />
        <rect x={g.face.x - 10} y={g.face.y + 16} width={7} height={5.5} rx={2.75} fill={INK} />
      </g>
    </g>
  );
}

function Earbuds({ g }: { g: ShapeGeometry }) {
  const { l, r, y } = g.ears;
  const bud = (x: number, flip: number) => (
    <g>
      <rect
        x={x - 1.6}
        y={y + 2}
        width={3.2}
        height={11}
        rx={1.6}
        fill={WHITE}
        stroke={LINE}
        strokeWidth={0.8}
      />
      <circle cx={x + flip * 0.5} cy={y} r={5} fill={WHITE} stroke={LINE} strokeWidth={0.8} />
      <circle cx={x + flip * 1.6} cy={y - 0.4} r={1.8} fill="#C9C9C4" />
    </g>
  );
  return (
    <g>
      {bud(l + 1.5, 1)}
      {bud(r - 1.5, -1)}
    </g>
  );
}

function Glasses({ g }: { g: ShapeGeometry }) {
  const { x, y } = g.face;
  const dx = g.eyeDx;
  const lens = (cx: number) => (
    <g>
      <circle cx={cx} cy={y} r={9.6} fill="rgba(255,255,255,0.22)" stroke={INK} strokeWidth={2.8} />
      <path
        d={`M${cx - 5.5} ${y - 4.5}Q${cx - 3} ${y - 7} ${cx + 0.5} ${y - 7.4}`}
        stroke="rgba(255,255,255,0.7)"
        strokeWidth={1.4}
        fill="none"
        strokeLinecap="round"
      />
    </g>
  );
  return (
    <g>
      <path
        d={`M${x - dx + 9.6} ${y - 1.5}Q${x} ${y - 5.5} ${x + dx - 9.6} ${y - 1.5}`}
        stroke={INK}
        strokeWidth={2.6}
        fill="none"
      />
      <path
        d={`M${x - dx - 9.6} ${y - 1.5}L${g.ears.l + 1} ${y - 3.5}`}
        stroke={INK}
        strokeWidth={2.4}
        strokeLinecap="round"
      />
      <path
        d={`M${x + dx + 9.6} ${y - 1.5}L${g.ears.r - 1} ${y - 3.5}`}
        stroke={INK}
        strokeWidth={2.4}
        strokeLinecap="round"
      />
      {lens(x - dx)}
      {lens(x + dx)}
    </g>
  );
}

function Bowtie({ g }: { g: ShapeGeometry }) {
  const x = g.face.x;
  const y = g.neckY;
  return (
    <g>
      <path
        d={`M${x} ${y}L${x - 12} ${y - 6.5}Q${x - 14} ${y} ${x - 12} ${y + 6.5}Z`}
        fill={INK}
        strokeLinejoin="round"
        stroke={INK}
        strokeWidth={2}
      />
      <path
        d={`M${x} ${y}L${x + 12} ${y - 6.5}Q${x + 14} ${y} ${x + 12} ${y + 6.5}Z`}
        fill={INK}
        strokeLinejoin="round"
        stroke={INK}
        strokeWidth={2}
      />
      <rect x={x - 3.4} y={y - 3.8} width={6.8} height={7.6} rx={2.4} fill={INK_HI} />
    </g>
  );
}

export function Accessory({ id, g }: { id: AccessoryId; g: ShapeGeometry }) {
  switch (id) {
    case "none":
      return null;
    case "beanie":
      return (
        <Hat g={g}>
          <Beanie />
        </Hat>
      );
    case "cap":
      return (
        <Hat g={g}>
          <Cap />
        </Hat>
      );
    case "chef":
      return (
        <Hat g={g}>
          <Chef />
        </Hat>
      );
    case "crown":
      return (
        <Hat g={g}>
          <Crown />
        </Hat>
      );
    case "antenna":
      return (
        <g transform={`translate(${g.hat.x} ${g.top + 2})`}>
          <Antenna />
        </g>
      );
    case "headset":
      return <Headset g={g} />;
    case "earbuds":
      return <Earbuds g={g} />;
    case "glasses":
      return <Glasses g={g} />;
    case "bowtie":
      return <Bowtie g={g} />;
  }
}

/** Accessories that sit on top of the head (drawn over the body but under nothing else). */
export const HAT_ACCESSORIES: readonly AccessoryId[] = ["beanie", "cap", "chef", "crown", "antenna"];
