/**
 * CupCats — kawaii cats sitting in cups (inspired by the CupCats collection), themed around Japanese food and
 * culture. Illustrated style: warm outline, flat pastel fills, cel shading (one soft shadow + one highlight) and
 * a little extra depth from contact shadows. Big, round, glossy "gerbil" eyes. Every CupCat wears Yo's headset;
 * when it wears a hat, the band hides under the hat and the earcups + boom mic stay visible.
 *
 * Draw order: aura → hood/back → headset band → head (+ muzzle, shading, ears, markings) → face → cup
 * → collar/topping → hat → earcups + mic.
 */
import type { Avatar as AvatarData } from "@yo/contracts";
import { type CupCatVariant, cupCatVariant } from "./cupcat-variants";
import { type Detail, DimDefs, DimHeadsetBack, DimHeadsetFront, materialFor, mix } from "./dimensional";
import type { EyeStyle } from "./eyes";
import { SHAPES } from "./shapes";

export const INK = "#4A2E26";

const G = SHAPES.cupcat;

/* --------------------------------- pieces --------------------------------- */

function Shade({ rid, color }: { rid: string; color: string }) {
  // Cel shading on the head: soft lower-right shadow, broad upper-left highlight, cup-rim contact shadow.
  return (
    <g clipPath={`url(#dc${rid})`}>
      <ellipse cx={74} cy={64} rx={30} ry={22} fill={color} opacity={0.34} />
      <ellipse cx={50} cy={62} rx={42} ry={5.5} fill={color} opacity={0.42} />
      <ellipse cx={31} cy={29} rx={15} ry={7} transform="rotate(-18 31 29)" fill="#FFFFFF" opacity={0.42} />
    </g>
  );
}

function InnerEars({ color }: { color: string }) {
  return (
    <g fill={color}>
      <path d="M17 11.5C21 14.5 26 18 29.5 21.5C25 22.5 20.5 24.5 16.5 27.5C16 21.5 16.2 16 17 11.5Z" />
      <path d="M83 11.5C79 14.5 74 18 70.5 21.5C75 22.5 79.5 24.5 83.5 27.5C84 21.5 83.8 16 83 11.5Z" />
    </g>
  );
}

function Muzzle({ color, rid, round }: { color: string; rid: string; round?: boolean }) {
  return (
    <g clipPath={`url(#dc${rid})`}>
      {round ? (
        <ellipse cx={50} cy={49} rx={30} ry={21} fill={color} />
      ) : (
        <path
          d="M4 55.5C11 52 17 51.5 23.5 54.5C30 50.5 38 50.5 43.5 54C47.5 51.5 52.5 51.5 56.5 54C62 50.5 70 50.5 76.5 54.5C83 51.5 89 52 96 55.5V80H4Z"
          fill={color}
        />
      )}
    </g>
  );
}

/** Big round glossy eye (gerbil-like). Shares the blink/look animation hooks. */
function GlossyEye({
  x,
  y,
  tint,
  rid,
  fine,
}: {
  x: number;
  y: number;
  tint: string;
  rid: string;
  fine: boolean;
}) {
  const r = fine ? 6.9 : 7.6;
  return (
    <g>
      <circle cx={x} cy={y} r={r} fill={`url(#ge${rid})`} />
      {fine && <circle cx={x} cy={y} r={r} fill="none" stroke={INK} strokeWidth={0.9} opacity={0.55} />}
      <circle cx={x} cy={y + r * 0.42} r={r * 0.62} fill={tint} opacity={0.55} clipPath={`url(#gc${rid})`} />
      <circle cx={x + r * 0.34} cy={y - r * 0.38} r={r * 0.36} fill="#FFFFFF" />
      {fine && <circle cx={x - r * 0.36} cy={y + r * 0.34} r={r * 0.15} fill="#FFFFFF" opacity={0.9} />}
      {fine && <circle cx={x - r * 0.12} cy={y - r * 0.62} r={r * 0.09} fill="#FFFFFF" opacity={0.8} />}
    </g>
  );
}

function Face({ v, eyes, rid, fine }: { v: CupCatVariant; eyes: EyeStyle; rid: string; fine: boolean }) {
  const lx = G.face.x - G.eyeDx;
  const rx = G.face.x + G.eyeDx;
  const y = G.face.y;
  const round = eyes === "capsule" || eyes === "round" || eyes === "x";
  const arc = (x: number, up: boolean) => (
    <path
      d={
        up
          ? `M${x - 6} ${y + 2}Q${x} ${y - 6} ${x + 6} ${y + 2}`
          : `M${x - 6} ${y - 1}Q${x} ${y + 5} ${x + 6} ${y - 1}`
      }
      fill="none"
      stroke={INK}
      strokeWidth={3}
      strokeLinecap="round"
    />
  );
  return (
    <g>
      {fine && (
        <g>
          <ellipse cx={23} cy={55} rx={6.2} ry={3.6} fill="#FF8FA3" opacity={0.55} />
          <ellipse cx={77} cy={55} rx={6.2} ry={3.6} fill="#FF8FA3" opacity={0.55} />
          <path
            d="M20.5 55.5L22 53.5M24 55.5L25.5 53.5M74.5 55.5L76 53.5M78 55.5L79.5 53.5"
            stroke="#FFFFFF"
            strokeWidth={0.9}
            strokeLinecap="round"
            opacity={0.8}
          />
          <path
            d="M46.3 54Q48.15 56.8 50 54.2Q51.85 56.8 53.7 54"
            fill="none"
            stroke={INK}
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path d="M48.9 51.6H51.1L50 52.9Z" fill="#F3879B" />
        </g>
      )}
      <g className="yo-av-look">
        <g className="yo-av-blink">
          {round ? (
            <>
              <GlossyEye x={lx} y={y} tint={v.eyeTint} rid={rid} fine={fine} />
              <GlossyEye x={rx} y={y} tint={v.eyeTint} rid={rid} fine={fine} />
            </>
          ) : (
            <>
              {arc(lx, eyes === "happy")}
              {arc(rx, eyes === "happy")}
            </>
          )}
        </g>
      </g>
    </g>
  );
}

function Marks({ kind, fine }: { kind: CupCatVariant["mark"]; fine: boolean }) {
  switch (kind) {
    case "none":
      return null;
    case "kitsune":
      return (
        <g fill="#D7263D">
          <path d="M50 26.5C52.5 30 52.5 33 50 36C47.5 33 47.5 30 50 26.5Z" />
          {fine && <circle cx={50} cy={31.3} r={1.2} fill="#FFD43B" />}
          <path d="M26.5 42C22 40.5 19 38 17.5 35C21.5 36 24.5 37.5 28 39.5Z" />
          <path d="M73.5 42C78 40.5 81 38 82.5 35C78.5 36 75.5 37.5 72 39.5Z" />
          <path d="M16.5 26L19.5 12L23 18Z" opacity={0.9} />
          <path d="M83.5 26L80.5 12L77 18Z" opacity={0.9} />
        </g>
      );
    case "daruma":
      return (
        <g>
          <path
            d="M28 35Q35.5 30 43 34.5M57 34.5Q64.5 30 72 35"
            stroke={INK}
            strokeWidth={3.2}
            fill="none"
            strokeLinecap="round"
          />
          {fine && (
            <g stroke="#F2C14E" strokeWidth={1.6} fill="none" strokeLinecap="round">
              <path d="M13.5 60C15.5 57 19 57.5 19 60.5C19 62.5 16.5 63 15.5 61.5" />
              <path d="M86.5 60C84.5 57 81 57.5 81 60.5C81 62.5 83.5 63 84.5 61.5" />
              <path d="M44 25C46 23.5 48 23.5 50 25C52 23.5 54 23.5 56 25" />
            </g>
          )}
        </g>
      );
    case "calico":
      return (
        <g>
          <path
            d="M12.5 24C14 15 15 9 14.5 6C21 11 29 18 35 21C31 27 22 31 13 31Z"
            fill="#F29A4A"
            opacity={0.95}
          />
          <path
            d="M85.5 6C80 11 72 17.5 65 21C68 25 73 27 80 27.5C84 23 86 14 85.5 6Z"
            fill="#3B3232"
            opacity={0.92}
          />
          <ellipse cx={80} cy={40} rx={7} ry={5} fill="#F29A4A" opacity={0.85} />
        </g>
      );
  }
}

/* ----------------------------------- cups ---------------------------------- */

const LINER = "M7 60L93 60L81.5 96C81 97.3 80 98 78.6 98H21.4C20 98 19 97.3 18.5 96Z";
const RAINBOW = ["#FF9AA8", "#FFC98B", "#FFF08F", "#A8E6C1", "#9AD6F5", "#C3B1FF"];

function Sparkle({ x, y, s = 1, color = "#FFFFFF" }: { x: number; y: number; s?: number; color?: string }) {
  return (
    <path
      d={`M${x} ${y - 3.2 * s}Q${x + 0.6 * s} ${y - 0.6 * s} ${x + 3.2 * s} ${y}Q${x + 0.6 * s} ${y + 0.6 * s} ${x} ${y + 3.2 * s}Q${x - 0.6 * s} ${y + 0.6 * s} ${x - 3.2 * s} ${y}Q${x - 0.6 * s} ${y - 0.6 * s} ${x} ${y - 3.2 * s}Z`}
      fill={color}
    />
  );
}

function Cup({ v, rid, fine, sw }: { v: CupCatVariant; rid: string; fine: boolean; sw: number }) {
  const { kind, color, accent } = v.cup;
  const base = color === "rainbow" ? "#FFFFFF" : color;
  const shade = mix(base, "#3A1F2A", 0.28);
  const line = { stroke: INK, strokeWidth: sw, strokeLinejoin: "round" as const };
  const clip = `cp${rid}`;
  const shadeRight = (
    <g clipPath={`url(#${clip})`}>
      <path d="M70 55L100 55L100 100L58 100Z" fill={shade} opacity={0.3} />
      <rect x={0} y={58} width={100} height={4.5} fill="#FFFFFF" opacity={0.35} />
    </g>
  );
  switch (kind) {
    case "liner":
      return (
        <g>
          <defs>
            <clipPath id={clip}>
              <path d={LINER} />
            </clipPath>
          </defs>
          <path d={LINER} fill={base} />
          {color === "rainbow" && (
            <g clipPath={`url(#${clip})`}>
              {RAINBOW.map((c, i) => (
                <path
                  key={c}
                  d={`M${-20 + i * 14} 100L${10 + i * 14} 55H${24 + i * 14}L${-6 + i * 14} 100Z`}
                  fill={c}
                />
              ))}
              <path d={`M${64} 100L${94} 55H${130}L${100} 100Z`} fill={RAINBOW[0]} />
            </g>
          )}
          {fine && accent && (
            <g clipPath={`url(#${clip})`}>
              {[18, 26.5, 35, 43.5, 52, 60.5, 69, 77.5, 86].map((x) => (
                <path
                  key={x}
                  d={`M${x} 61L${50 + (x - 50) * 0.7} 98`}
                  stroke={accent}
                  strokeWidth={1.3}
                  opacity={0.6}
                />
              ))}
            </g>
          )}
          {fine && color === "rainbow" && (
            <g>
              <Sparkle x={30} y={74} s={1.1} />
              <Sparkle x={62} y={84} s={0.8} />
              <Sparkle x={72} y={68} s={0.9} />
            </g>
          )}
          {shadeRight}
          {/* Scalloped paper rim. */}
          <path
            d="M6 61.5Q9.6 57.5 13.2 61.5Q16.8 57.5 20.4 61.5Q24 57.5 27.6 61.5Q31.2 57.5 34.8 61.5Q38.4 57.5 42 61.5Q45.6 57.5 49.2 61.5Q52.8 57.5 56.4 61.5Q60 57.5 63.6 61.5Q67.2 57.5 70.8 61.5Q74.4 57.5 78 61.5Q81.6 57.5 85.2 61.5Q88.8 57.5 92.4 61.5L94 61.5L93 64.5H7L6 61.5Z"
            fill="#FFFFFF"
            {...line}
          />
          <path d={LINER} fill="none" {...line} />
        </g>
      );
    case "latte": {
      const body = "M10 57.5H90L86 86C84.5 95 79 98 72 98H28C21 98 15.5 95 14 86Z";
      return (
        <g>
          <defs>
            <clipPath id={clip}>
              <path d={body} />
            </clipPath>
          </defs>
          <path
            d="M13 66C3.5 65 2 75 4 80C6.5 86 11.5 87 15 86"
            fill="none"
            stroke={INK}
            strokeWidth={sw + 4.4}
            strokeLinecap="round"
          />
          <path
            d="M13 66C3.5 65 2 75 4 80C6.5 86 11.5 87 15 86"
            fill="none"
            stroke={base}
            strokeWidth={4.4}
            strokeLinecap="round"
          />
          <path d={body} fill={base} opacity={0.96} />
          <g clipPath={`url(#${clip})`}>
            <rect x={0} y={71} width={100} height={30} fill={accent ?? "#B98563"} />
            <path
              d="M0 63H100V73C90 70.5 80 75 70 72C60 69.5 50 75 40 72C30 69.5 20 75 10 72C6 71 3 72 0 73Z"
              fill="#F6E6D2"
            />
            <rect x={14} y={64} width={4} height={30} rx={2} fill="#FFFFFF" opacity={0.45} />
          </g>
          {shadeRight}
          <path d={body} fill="none" {...line} />
        </g>
      );
    }
    case "bowl": {
      const body = "M5 60H95C94 83 76 93.5 50 93.5C24 93.5 6 83 5 60Z";
      return (
        <g>
          <defs>
            <clipPath id={clip}>
              <path d={body} />
            </clipPath>
          </defs>
          <path d="M35 91H65L67.5 98H32.5Z" fill={shade} {...line} />
          <path d={body} fill={base} />
          <g clipPath={`url(#${clip})`}>
            <rect x={0} y={66} width={100} height={3.4} fill={accent ?? "#FFFFFF"} />
            {fine && (
              <g stroke={accent ?? "#FFFFFF"} strokeWidth={1.2} fill="none" opacity={0.9}>
                <path d="M20 76h6v5h-4v-3" />
                <path d="M47 79h6v5h-4v-3" />
                <path d="M74 76h6v5h-4v-3" />
              </g>
            )}
          </g>
          {shadeRight}
          <path d={body} fill="none" {...line} />
        </g>
      );
    }
    case "box": {
      const body = "M12 62H88V96C88 97.1 87.1 98 86 98H14C12.9 98 12 97.1 12 96Z";
      return (
        <g>
          <defs>
            <clipPath id={clip}>
              <path d={body} />
            </clipPath>
          </defs>
          <path d="M12 62L3 54.5L33 54.5L40 62Z" fill={mix(base, "#FFFFFF", 0.35)} {...line} />
          <path d="M88 62L97 54.5L67 54.5L60 62Z" fill={mix(base, "#3A1F2A", 0.08)} {...line} />
          <path d={body} fill={base} />
          {fine && (
            <g>
              <rect x={22} y={70} width={34} height={20} rx={4} fill="#FFFFFF" opacity={0.9} />
              <circle cx={46} cy={80} r={5} fill={accent ?? "#FF9EB5"} />
              <path
                d="M26 76h12M26 80h9M26 84h11"
                stroke={INK}
                strokeWidth={1}
                opacity={0.5}
                strokeLinecap="round"
              />
              <circle cx={70} cy={74} r={3} fill="#FFFFFF" opacity={0.7} />
              <circle cx={76} cy={86} r={2.2} fill="#FFFFFF" opacity={0.7} />
            </g>
          )}
          {shadeRight}
          <path d={body} fill="none" {...line} />
        </g>
      );
    }
    case "bento": {
      const body = "M7 63H93V93C93 95.8 90.8 98 88 98H12C9.2 98 7 95.8 7 93Z";
      return (
        <g>
          <defs>
            <clipPath id={clip}>
              <path d={body} />
            </clipPath>
          </defs>
          <path d={body} fill={base} />
          <g clipPath={`url(#${clip})`}>
            <rect x={0} y={63} width={100} height={5} fill={shade} opacity={0.55} />
          </g>
          {shadeRight}
          <path d={body} fill="none" {...line} />
          {/* Food peeking over the rim. */}
          <g>
            <path d="M14 66L22 54L30 66Z" fill="#FFFFFF" {...line} />
            <rect x={17.5} y={61} width={9} height={5} fill="#23302A" />
            <rect x={70} y={57} width={14} height={9} rx={2.5} fill="#FFD85A" {...line} />
            {fine && <path d="M70 61.5H84" stroke="#F5B400" strokeWidth={1.1} />}
            <circle cx={41} cy={62} r={4.2} fill="#FF8FB1" {...line} />
            <circle cx={41} cy={62} r={1.4} fill="#FFD43B" />
            <path d="M52 66C52 58 60 57 63 60C60 60.5 58 63 58 66Z" fill="#7CC36B" {...line} />
          </g>
        </g>
      );
    }
    case "float": {
      const bowl = "M9 58.5H91C90 77 73 86 50 86C27 86 10 77 9 58.5Z";
      return (
        <g>
          <defs>
            <clipPath id={clip}>
              <path d={bowl} />
            </clipPath>
          </defs>
          <path d="M45 85H55V93H45Z" fill="#E6F4FF" {...line} />
          <ellipse cx={50} cy={95} rx={18} ry={3.6} fill="#E6F4FF" {...line} />
          <path d={bowl} fill="#E9F7FF" opacity={0.9} />
          <g clipPath={`url(#${clip})`}>
            <path d="M0 65C15 62 30 67 50 64C70 61 85 66 100 64V100H0Z" fill={base} opacity={0.92} />
            {fine &&
              [
                [26, 74, 1.6],
                [40, 79, 1.1],
                [60, 72, 1.4],
                [72, 78, 1],
              ].map(([x, y, r]) => <circle key={x} cx={x} cy={y} r={r} fill="#FFFFFF" opacity={0.75} />)}
            <path
              d="M17 64C21 72 30 78 42 80"
              stroke="#FFFFFF"
              strokeWidth={2.2}
              fill="none"
              opacity={0.6}
              strokeLinecap="round"
            />
          </g>
          {shadeRight}
          <path d={bowl} fill="none" {...line} />
        </g>
      );
    }
    case "pot": {
      const body = "M15 67H85L78 95.5C77.6 97 76.4 98 74.8 98H25.2C23.6 98 22.4 97 22 95.5Z";
      return (
        <g>
          <defs>
            <clipPath id={clip}>
              <path d={body} />
              <rect x={8} y={57} width={84} height={11} rx={3.5} />
            </clipPath>
          </defs>
          <path d={body} fill={base} />
          <rect x={8} y={57} width={84} height={11} rx={3.5} fill={mix(base, "#FFFFFF", 0.18)} />
          {fine && (
            <g stroke={accent ?? INK} strokeWidth={1.4} fill="none" opacity={0.85}>
              <path d="M30 80C33 76 38 76 38 80.5C38 83.5 34.5 84 33.5 82" />
              <path d="M62 84C65 80 70 80 70 84.5C70 87.5 66.5 88 65.5 86" />
            </g>
          )}
          {shadeRight}
          <path d={body} fill="none" {...line} />
          <rect x={8} y={57} width={84} height={11} rx={3.5} fill="none" {...line} />
        </g>
      );
    }
    case "masu": {
      const body = "M10 60H90V95C90 96.7 88.7 98 87 98H13C11.3 98 10 96.7 10 95Z";
      return (
        <g>
          <defs>
            <clipPath id={clip}>
              <path d={body} />
            </clipPath>
          </defs>
          <path d={body} fill={base} />
          <g clipPath={`url(#${clip})`}>
            <rect x={0} y={60} width={100} height={5} fill={accent ?? "#F2C14E"} />
            {fine && (
              <g fill={accent ?? "#F2C14E"}>
                <path d="M10 98L20 88L22 90L12 98Z" />
                <path d="M90 98L80 88L78 90L88 98Z" />
                <circle cx={50} cy={80} r={6} fill="none" stroke={accent ?? "#F2C14E"} strokeWidth={1.6} />
                <path d="M47 80H53M50 77V83" stroke={accent ?? "#F2C14E"} strokeWidth={1.4} />
              </g>
            )}
          </g>
          {shadeRight}
          <path d={body} fill="none" {...line} />
        </g>
      );
    }
  }
}

/* --------------------------------- toppings -------------------------------- */

function Topping({ kind, fine, sw }: { kind: CupCatVariant["topping"]; fine: boolean; sw: number }) {
  const line = { stroke: INK, strokeWidth: sw * 0.85, strokeLinejoin: "round" as const };
  const blossom = (x: number, y: number, r: number) => (
    <g>
      {[0, 72, 144, 216, 288].map((a) => (
        <ellipse
          key={a}
          cx={x + r * Math.cos(((a - 90) * Math.PI) / 180)}
          cy={y + r * Math.sin(((a - 90) * Math.PI) / 180)}
          rx={r * 0.78}
          ry={r * 0.62}
          transform={`rotate(${a} ${x + r * Math.cos(((a - 90) * Math.PI) / 180)} ${y + r * Math.sin(((a - 90) * Math.PI) / 180)})`}
          fill="#FFB7CB"
          {...line}
        />
      ))}
      <circle cx={x} cy={y} r={r * 0.45} fill="#FF7FA2" />
    </g>
  );
  switch (kind) {
    case "none":
      return null;
    case "sakura":
      return (
        <g>
          <path d="M31 21C35 17 39 17 42 18.5C39 21 35 22 31 21Z" fill="#7CC36B" {...line} />
          {blossom(23, 20, 3.6)}
          {fine && blossom(32.5, 14.5, 2.6)}
        </g>
      );
    case "flower":
      return blossom(23, 20, 3.6);
    case "macarons":
      return (
        <g>
          {[
            [42, "#FFB3C7"],
            [58, "#B9B0FF"],
          ].map(([x, c]) => (
            <g key={x as number}>
              <rect
                x={(x as number) - 7}
                y={10}
                width={14}
                height={4.8}
                rx={2.4}
                fill={c as string}
                {...line}
              />
              <rect x={(x as number) - 6.2} y={14.4} width={12.4} height={2} fill="#FFF3E6" />
              <rect
                x={(x as number) - 7}
                y={16.2}
                width={14}
                height={4.8}
                rx={2.4}
                fill={c as string}
                {...line}
              />
            </g>
          ))}
        </g>
      );
    case "ramen":
      return (
        <g>
          <path d="M60 17L94 3M62 20L95 8" stroke="#C88A4A" strokeWidth={2.2} strokeLinecap="round" />
          <path
            d="M72 11C71 16 74 18 72 23M76 10C75 15 78 17 76 22M80 8C79 13 82 15 80 20"
            stroke="#F4D35E"
            strokeWidth={1.6}
            fill="none"
            strokeLinecap="round"
          />
          <circle cx={27} cy={19} r={5.6} fill="#FFFFFF" {...line} />
          <path
            d="M27 19m-2.8 0a2.8 2.8 0 1 1 2.8 2.8a1.6 1.6 0 1 1 1.4 -1.6"
            stroke="#F3879B"
            strokeWidth={1.3}
            fill="none"
          />
        </g>
      );
    case "dango":
      return (
        <g>
          <path d="M17 29L49 4" stroke="#C88A4A" strokeWidth={1.8} strokeLinecap="round" />
          <circle cx={24} cy={23.5} r={5} fill="#9BD37F" {...line} />
          <circle cx={32} cy={17} r={5} fill="#FFFFFF" {...line} />
          <circle cx={40} cy={10.5} r={5} fill="#FFB3C7" {...line} />
        </g>
      );
    case "float":
      return (
        <g>
          <path d="M37 21C35 15 40 10 44 12C45 7 55 7 56 12C60 10 65 15 63 21Z" fill="#FFFDF5" {...line} />
          <path
            d="M51 9C52 4 55 2 58 2"
            stroke="#3F8F3A"
            strokeWidth={1.4}
            fill="none"
            strokeLinecap="round"
          />
          <circle cx={50} cy={10} r={4.2} fill="#E8364F" {...line} />
          {fine && <circle cx={48.6} cy={8.6} r={1.2} fill="#FFFFFF" opacity={0.8} />}
        </g>
      );
    case "pancakes":
      return (
        <g>
          <ellipse cx={52} cy={19} rx={17} ry={4.5} fill="#D99A58" {...line} />
          <ellipse cx={52} cy={14.5} rx={16} ry={4.3} fill="#E7AE6A" {...line} />
          <ellipse cx={52} cy={10.2} rx={15} ry={4} fill="#F0C07E" {...line} />
          <path d="M44 9.5C44 14 47 15 46.5 20C49 17 50 12 50 9.5Z" fill="#F6A623" opacity={0.9} />
          <rect x={52} y={6} width={6} height={4} rx={1} fill="#FFF3B0" {...line} />
        </g>
      );
    case "koban":
      return (
        <g>
          <ellipse cx={50} cy={13} rx={9} ry={6} fill="#F2C14E" {...line} />
          {fine && <path d="M44.5 11H55.5M44.5 13H55.5M44.5 15H55.5" stroke="#C98A12" strokeWidth={0.9} />}
        </g>
      );
    case "lollipops":
      return (
        <g>
          <path d="M21 22L26 30M79 22L74 30" stroke="#FFFFFF" strokeWidth={1.6} strokeLinecap="round" />
          <circle cx={19} cy={18} r={5.2} fill="#FF8FB1" {...line} />
          <circle cx={81} cy={18} r={5.2} fill="#FFB25B" {...line} />
          {fine && (
            <g stroke="#FFFFFF" strokeWidth={1.2} fill="none" opacity={0.85}>
              <path d="M19 18m-2.6 0a2.6 2.6 0 1 1 2.6 2.6" />
              <path d="M81 18m-2.6 0a2.6 2.6 0 1 1 2.6 2.6" />
            </g>
          )}
        </g>
      );
  }
}

/* ----------------------------------- hats ---------------------------------- */

function HatBack({ kind, sw }: { kind: CupCatVariant["hat"]; sw: number }) {
  if (kind !== "frog") return null;
  return (
    <path
      d="M50 2C75 2 96 14 97 40C98 58 94 70 88 74H12C6 70 2 58 3 40C4 14 25 2 50 2Z"
      fill="#5FBF5A"
      stroke={INK}
      strokeWidth={sw}
    />
  );
}

function HatFront({ kind, sw, fine }: { kind: CupCatVariant["hat"]; sw: number; fine: boolean }) {
  const line = { stroke: INK, strokeWidth: sw, strokeLinejoin: "round" as const };
  switch (kind) {
    case "none":
      return null;
    case "frog":
      return (
        <g>
          <path
            d="M3 42C3 14 25 2 50 2C75 2 97 14 97 42C88 31 71 26 50 26C29 26 12 31 3 42Z"
            fill="#5FBF5A"
            {...line}
          />
          {fine && (
            <path
              d="M18 30C28 25 40 23.5 50 23.5"
              stroke="#8FD88A"
              strokeWidth={2}
              fill="none"
              strokeLinecap="round"
            />
          )}
          {[29, 71].map((x) => (
            <g key={x}>
              <circle cx={x} cy={9} r={8.5} fill="#5FBF5A" {...line} />
              <circle cx={x} cy={8.5} r={5.2} fill="#FFFFFF" />
              <circle cx={x + 0.8} cy={9} r={3} fill={INK} />
              <circle cx={x + 1.8} cy={7.6} r={1} fill="#FFFFFF" />
            </g>
          ))}
          <ellipse cx={50} cy={20} rx={3} ry={1.6} fill="#F07A8A" opacity={0.8} />
        </g>
      );
    case "sailor":
      return (
        <g transform="rotate(-8 50 20)">
          <path d="M84 27C90 29 93 34 95 39L91 40C89 36 86 32 81 30Z" fill="#8C7BEF" {...line} />
          <path d="M24 26C25 11 38 4.5 50 4.5C62 4.5 75 11 76 26Z" fill="#FFFFFF" {...line} />
          <path d="M22 25.5Q50 33 78 25.5L77 31.5Q50 39 23 31.5Z" fill="#23346B" {...line} />
          {fine && <path d="M30 29.8Q50 34.5 70 29.8" stroke="#F2C14E" strokeWidth={1} fill="none" />}
        </g>
      );
    case "witch":
      return (
        <g>
          <ellipse cx={47} cy={24} rx={40} ry={7.5} fill="#4C3F95" {...line} />
          <path d="M28 23C33 11 42 4 60 1C55 8 56 15 64 23Z" fill="#5A4BAE" {...line} />
          <path d="M28.5 21.5Q46 26 63.5 21.5L64.5 24.5Q46 29.5 27.5 24.5Z" fill="#B8923A" {...line} />
          <rect
            x={42.5}
            y={20.5}
            width={6}
            height={6}
            rx={1}
            fill="none"
            stroke="#F2D27A"
            strokeWidth={1.3}
          />
          {fine && (
            <path
              d="M38 12C44 8 50 5 57 3"
              stroke="#7F70D6"
              strokeWidth={1.6}
              fill="none"
              strokeLinecap="round"
            />
          )}
        </g>
      );
    case "maid":
      return (
        <g>
          <path
            d="M20 27Q22 20 27.5 22Q29 15.5 35 18Q38 12 44 15Q47 10 50 10Q53 10 56 15Q62 12 65 18Q71 15.5 72.5 22Q78 20 80 27Q50 19 20 27Z"
            fill="#FFFFFF"
            {...line}
          />
          {fine && <path d="M26 25.5Q50 18.5 74 25.5" stroke="#E7E0F5" strokeWidth={1.4} fill="none" />}
          {[14, 86].map((x) => (
            <g key={x} fill="#241C24">
              <path d={`M${x} 30L${x - 7} 25L${x - 7} 36Z`} {...line} />
              <path d={`M${x} 30L${x + 7} 25L${x + 7} 36Z`} {...line} />
              <circle cx={x} cy={30} r={2.4} />
              <path d={`M${x - 1.5} 32L${x - 4} 48L${x + 0.5} 46Z`} />
            </g>
          ))}
        </g>
      );
  }
}

/* ---------------------------------- figure --------------------------------- */

export function CupCatFigure({
  avatar,
  rid,
  eyes,
  detail,
}: {
  avatar: AvatarData;
  rid: string;
  eyes: EyeStyle;
  detail: Detail;
}) {
  const v = cupCatVariant(avatar.variant);
  const fine = detail !== "compact";
  const sw = detail === "compact" ? 2.6 : detail === "standard" ? 1.9 : 1.6;
  const m = materialFor(v.fur, v.fur);
  const furShade = mix(v.fur, "#5A2A48", 0.5);
  const innerEar = v.mark === "kitsune" ? "#FFD1DA" : mix(v.fur, "#FF8FAE", 0.55);
  const headset = avatar.accessory !== "none";
  const hat = v.hat !== "none";
  return (
    <>
      <defs>
        <DimDefs g={G} m={m} rid={rid} detail={detail} />
        <radialGradient id={`ge${rid}`} cx="50%" cy="35%" r="70%">
          <stop offset="0" stopColor="#3A2436" />
          <stop offset="1" stopColor="#120A12" />
        </radialGradient>
        <clipPath id={`gc${rid}`}>
          <circle cx={G.face.x - G.eyeDx} cy={G.face.y} r={fine ? 6.9 : 7.6} />
          <circle cx={G.face.x + G.eyeDx} cy={G.face.y} r={fine ? 6.9 : 7.6} />
        </clipPath>
      </defs>

      {v.sparkle && fine && (
        <g className="yo-av-sparkle">
          <Sparkle x={6} y={30} s={1.4} color="#FFE27A" />
          <Sparkle x={95} y={74} s={1.2} color="#9AD6F5" />
          <Sparkle x={96} y={30} s={0.9} color="#FF9AA8" />
          <Sparkle x={5} y={80} s={0.9} color="#C3B1FF" />
        </g>
      )}

      <HatBack kind={v.hat} sw={sw} />
      {headset && !hat && <DimHeadsetBack g={G} detail={detail} />}

      {/* Head */}
      <path d={G.paths[0]} fill={v.fur} />
      <InnerEars color={innerEar} />
      {v.muzzle && <Muzzle color={v.muzzle} rid={rid} round={v.mark === "daruma"} />}
      <Marks kind={v.mark} fine={fine} />
      {fine && <Shade rid={rid} color={furShade} />}
      <path d={G.paths[0]} fill="none" stroke={INK} strokeWidth={sw} strokeLinejoin="round" />

      <Face v={v} eyes={eyes} rid={rid} fine={fine} />

      <Cup v={v} rid={rid} fine={fine} sw={sw} />
      {v.mark === "calico" && (
        <g>
          <path
            d="M16 58.5Q50 66 84 58.5L83 62.5Q50 70 17 62.5Z"
            fill="#D7263D"
            stroke={INK}
            strokeWidth={sw * 0.8}
          />
          <circle cx={50} cy={66} r={4.4} fill="#F2C14E" stroke={INK} strokeWidth={sw * 0.8} />
          <path d="M47.5 66.5H52.5" stroke={INK} strokeWidth={0.9} />
        </g>
      )}

      {fine && <Topping kind={v.topping} fine={fine} sw={sw} />}
      <HatFront kind={v.hat} sw={sw} fine={fine} />

      {headset && <DimHeadsetFront g={G} rid={rid} detail={detail} />}
    </>
  );
}
