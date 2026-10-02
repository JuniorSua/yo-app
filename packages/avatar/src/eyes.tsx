import type { AVATAR_EYES } from "@yo/contracts";

export type EyeStyle = (typeof AVATAR_EYES)[number] | "x" | "closed";

function Eye({ kind, x, y, color }: { kind: EyeStyle; x: number; y: number; color: string }) {
  switch (kind) {
    case "capsule":
      return <rect x={x - 4.3} y={y - 7.6} width={8.6} height={15.2} rx={4.3} fill={color} />;
    case "round":
      return (
        <g>
          <circle cx={x} cy={y} r={5.6} fill={color} />
          <circle cx={x + 1.9} cy={y - 2} r={1.7} fill="#fff" opacity={0.9} />
        </g>
      );
    case "sleepy":
      return (
        <g>
          <path d={`M${x - 5.6} ${y - 1}A5.6 5.6 0 0 0 ${x + 5.6} ${y - 1}Z`} fill={color} />
          <path
            d={`M${x - 6.4} ${y - 1.4}H${x + 6.4}`}
            stroke={color}
            strokeWidth={2.4}
            strokeLinecap="round"
          />
        </g>
      );
    case "happy":
      return (
        <path
          d={`M${x - 5.4} ${y + 2.4}Q${x} ${y - 6.6} ${x + 5.4} ${y + 2.4}`}
          fill="none"
          stroke={color}
          strokeWidth={3.6}
          strokeLinecap="round"
        />
      );
    case "closed":
      return (
        <path
          d={`M${x - 5.2} ${y}Q${x} ${y + 4.6} ${x + 5.2} ${y}`}
          fill="none"
          stroke={color}
          strokeWidth={3.2}
          strokeLinecap="round"
        />
      );
    case "x":
      return (
        <path
          d={`M${x - 4} ${y - 4}L${x + 4} ${y + 4}M${x + 4} ${y - 4}L${x - 4} ${y + 4}`}
          fill="none"
          stroke={color}
          strokeWidth={3.2}
          strokeLinecap="round"
        />
      );
  }
}

export function Eyes({
  kind,
  x,
  y,
  dx,
  color,
}: {
  kind: EyeStyle;
  x: number;
  y: number;
  dx: number;
  color: string;
}) {
  return (
    <g className="yo-av-look">
      <g className="yo-av-blink">
        <Eye kind={kind} x={x - dx} y={y} color={color} />
        <Eye kind={kind} x={x + dx} y={y} color={color} />
      </g>
    </g>
  );
}
