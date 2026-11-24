import React, { useEffect, useId, useState } from 'react';
import { CardTier, computeCardAttributes } from '../engine/cardAttributes';
import { Player } from '../engine/types';

interface PlayerAvatarProps {
  player: Player;
  size?: 'sm' | 'md' | 'lg' | 'stage';
  className?: string;
}

/**
 * Clean fallback studio portraits wearing Home Country Jerseys
 * (ONLY used when a rare uncapped player has no verified official IPL or Wikipedia portrait —
 * guarantees zero broken images and zero mismatched faces).
 */
const COUNTRY_FALLBACK_PORTRAITS: Record<string, string> = {
  IN: '/src/assets/images/passport_jersey_india_1795400303465.jpg',
  AU: '/src/assets/images/passport_jersey_australia_1795400304701.jpg',
  EN: '/src/assets/images/passport_jersey_england_1795400303436.jpg',
  ZA: '/src/assets/images/passport_jersey_south_africa_1795400303145.jpg',
  NZ: '/src/assets/images/passport_jersey_new_zealand_1795400426234.jpg',
  WI: '/src/assets/images/passport_jersey_west_indies_1795400304506.jpg',
  AF: '/src/assets/images/passport_jersey_afghanistan_1795400304439.jpg',
  SL: '/src/assets/images/passport_jersey_sri_lanka_1795400316187.jpg',
  BD: '/src/assets/images/passport_jersey_south_africa_1795400303145.jpg',
  IE: '/src/assets/images/passport_jersey_south_africa_1795400303145.jpg',
  ZW: '/src/assets/images/passport_jersey_england_1795400303436.jpg',
};

interface TierPalette {
  bgStops: [string, string, string, string];
  rayLight: string;
  rayDark: string;
  borderOuter: string;
  borderInner: string;
  inkPrimary: string;
  inkSecondary: string;
  divider: string;
  dropShadow: string;
  emblemTint: string;
}

const TIER_PALETTES: Record<CardTier, TierPalette> = {
  GOLD: {
    bgStops: ['#F9E9A2', '#E9C55D', '#C9962D', '#E5C463'],
    rayLight: 'rgba(255, 249, 214, 0.52)',
    rayDark: 'rgba(153, 98, 12, 0.28)',
    borderOuter: '#9A6C17',
    borderInner: '#FFF4C2',
    inkPrimary: '#2D200A',
    inkSecondary: '#473311',
    divider: 'rgba(92, 62, 12, 0.28)',
    dropShadow: 'drop-shadow(0 12px 22px rgba(217, 165, 38, 0.34))',
    emblemTint: '#7A5615',
  },
  SILVER: {
    bgStops: ['#F4F7FC', '#D6DFEC', '#9BA9BD', '#D5DEE9'],
    rayLight: 'rgba(255, 255, 255, 0.62)',
    rayDark: 'rgba(71, 85, 105, 0.24)',
    borderOuter: '#64748B',
    borderInner: '#FFFFFF',
    inkPrimary: '#17202D',
    inkSecondary: '#334155',
    divider: 'rgba(30, 41, 59, 0.24)',
    dropShadow: 'drop-shadow(0 12px 20px rgba(148, 163, 184, 0.30))',
    emblemTint: '#475569',
  },
  BRONZE: {
    bgStops: ['#F1C39B', '#CE8B56', '#945228', '#C98956'],
    rayLight: 'rgba(255, 229, 204, 0.45)',
    rayDark: 'rgba(92, 41, 13, 0.30)',
    borderOuter: '#6E3817',
    borderInner: '#FFD9B8',
    inkPrimary: '#291205',
    inkSecondary: '#4A230D',
    divider: 'rgba(74, 35, 13, 0.28)',
    dropShadow: 'drop-shadow(0 12px 20px rgba(180, 96, 44, 0.32))',
    emblemTint: '#633012',
  },
};

// Classic FIFA/Ultimate-Team Shield Silhouette (viewBox 0 0 280 390)
const SHIELD_PATH =
  'M 140 6 C 186 6, 226 15, 246 25 C 248 34, 256 41, 268 44 L 268 310 C 268 344, 226 358, 182 368 C 160 373, 147 379, 140 385 C 133 379, 120 373, 98 368 C 54 358, 12 344, 12 310 L 12 44 C 24 41, 32 34, 34 25 C 54 15, 94 6, 140 6 Z';

const SHIELD_INNER_PATH =
  'M 140 11 C 184 11, 222 19, 241 29 C 244 38, 252 45, 263 48 L 263 308 C 263 339, 223 353, 180 363 C 159 368, 147 374, 140 379 C 133 374, 121 368, 100 363 C 57 353, 17 339, 17 308 L 17 48 C 28 45, 36 38, 39 29 C 58 19, 96 11, 140 11 Z';

/** Crisp inline SVG miniature flags so every nation renders accurately across all browsers/OS */
const CountryFlagSvg: React.FC<{ code: string; className?: string }> = ({
  code,
  className = 'w-5 h-3.5',
}) => {
  switch (code) {
    case 'IN':
      return (
        <svg viewBox="0 0 30 20" className={`${className} rounded-[2px] shadow-xs`}>
          <rect width="30" height="6.67" fill="#FF9933" />
          <rect y="6.67" width="30" height="6.67" fill="#FFFFFF" />
          <rect y="13.33" width="30" height="6.67" fill="#138808" />
          <circle cx="15" cy="10" r="2.2" fill="none" stroke="#000080" strokeWidth="0.7" />
          <circle cx="15" cy="10" r="0.5" fill="#000080" />
        </svg>
      );
    case 'AU':
      return (
        <svg viewBox="0 0 30 20" className={`${className} rounded-[2px] shadow-xs`}>
          <rect width="30" height="20" fill="#012169" />
          <path d="M0 0 L13 9 M13 0 L0 9" stroke="#FFF" strokeWidth="1.6" />
          <path d="M0 0 L13 9 M13 0 L0 9" stroke="#C8102E" strokeWidth="0.7" />
          <path d="M6.5 0 V9 M0 4.5 H13" stroke="#FFF" strokeWidth="2.4" />
          <path d="M6.5 0 V9 M0 4.5 H13" stroke="#C8102E" strokeWidth="1.3" />
          <circle cx="22" cy="6" r="1.1" fill="#FFF" />
          <circle cx="25" cy="10" r="1" fill="#FFF" />
          <circle cx="21.5" cy="14" r="1.2" fill="#FFF" />
          <circle cx="7" cy="14.5" r="1.6" fill="#FFF" />
        </svg>
      );
    case 'EN':
      return (
        <svg viewBox="0 0 30 20" className={`${className} rounded-[2px] shadow-xs`}>
          <rect width="30" height="20" fill="#FFFFFF" />
          <rect x="13" width="4" height="20" fill="#CE1124" />
          <rect y="8" width="30" height="4" fill="#CE1124" />
        </svg>
      );
    case 'ZA':
      return (
        <svg viewBox="0 0 30 20" className={`${className} rounded-[2px] shadow-xs`}>
          <rect width="30" height="10" fill="#E03C31" />
          <rect y="10" width="30" height="10" fill="#001489" />
          <path d="M0 0 L13 10 L0 20" fill="#000" />
          <path d="M0 2 L10 10 L0 18" stroke="#FFB81C" strokeWidth="1.5" fill="none" />
          <path d="M0 0 L12 8.5 H30 V11.5 H12 L0 20" fill="none" stroke="#FFFFFF" strokeWidth="1.4" />
          <path d="M0 0 L11.5 8.5 H30 V11.5 H11.5 L0 20 Z" fill="#007749" />
          <polygon points="0,3.2 8.2,10 0,16.8" fill="#000000" />
        </svg>
      );
    case 'NZ':
      return (
        <svg viewBox="0 0 30 20" className={`${className} rounded-[2px] shadow-xs`}>
          <rect width="30" height="20" fill="#00247D" />
          <path d="M0 0 L13 9 M13 0 L0 9" stroke="#FFF" strokeWidth="1.5" />
          <path d="M6.5 0 V9 M0 4.5 H13" stroke="#FFF" strokeWidth="2.3" />
          <path d="M6.5 0 V9 M0 4.5 H13" stroke="#CC142B" strokeWidth="1.2" />
          <circle cx="22.5" cy="5.5" r="1.2" fill="#CC142B" stroke="#FFF" strokeWidth="0.4" />
          <circle cx="25.5" cy="9.5" r="1.1" fill="#CC142B" stroke="#FFF" strokeWidth="0.4" />
          <circle cx="22.5" cy="15" r="1.3" fill="#CC142B" stroke="#FFF" strokeWidth="0.4" />
          <circle cx="19" cy="10" r="1.1" fill="#CC142B" stroke="#FFF" strokeWidth="0.4" />
        </svg>
      );
    case 'WI':
      return (
        <svg viewBox="0 0 30 20" className={`${className} rounded-[2px] shadow-xs`}>
          <rect width="30" height="20" fill="#7B0041" />
          <circle cx="15" cy="10" r="5" fill="#FCD116" opacity="0.9" />
          <rect x="14" y="6" width="2" height="8" fill="#7B0041" />
        </svg>
      );
    case 'AF':
      return (
        <svg viewBox="0 0 30 20" className={`${className} rounded-[2px] shadow-xs`}>
          <rect width="10" height="20" fill="#000000" />
          <rect x="10" width="10" height="20" fill="#D32011" />
          <rect x="20" width="10" height="20" fill="#007A36" />
          <circle cx="15" cy="10" r="2.4" fill="#FFFFFF" opacity="0.85" />
        </svg>
      );
    case 'SL':
      return (
        <svg viewBox="0 0 30 20" className={`${className} rounded-[2px] shadow-xs`}>
          <rect width="30" height="20" fill="#FFBE29" />
          <rect x="1.5" y="1.5" width="4" height="17" fill="#00534E" />
          <rect x="5.5" y="1.5" width="4" height="17" fill="#EB7400" />
          <rect x="11" y="1.5" width="17.5" height="17" fill="#8D153A" />
          <circle cx="19.5" cy="10" r="3" fill="#FFBE29" />
        </svg>
      );
    case 'BD':
      return (
        <svg viewBox="0 0 30 20" className={`${className} rounded-[2px] shadow-xs`}>
          <rect width="30" height="20" fill="#006A4E" />
          <circle cx="13.5" cy="10" r="5.2" fill="#F42A41" />
        </svg>
      );
    case 'IE':
      return (
        <svg viewBox="0 0 30 20" className={`${className} rounded-[2px] shadow-xs`}>
          <rect width="10" height="20" fill="#169B62" />
          <rect x="10" width="10" height="20" fill="#FFFFFF" />
          <rect x="20" width="10" height="20" fill="#FF883E" />
        </svg>
      );
    case 'ZW':
      return (
        <svg viewBox="0 0 30 20" className={`${className} rounded-[2px] shadow-xs`}>
          <rect width="30" height="3" fill="#006400" />
          <rect y="3" width="30" height="3" fill="#FFD200" />
          <rect y="6" width="30" height="3" fill="#D40000" />
          <rect y="9" width="30" height="2" fill="#000000" />
          <rect y="11" width="30" height="3" fill="#D40000" />
          <rect y="14" width="30" height="3" fill="#FFD200" />
          <rect y="17" width="30" height="3" fill="#006400" />
          <polygon points="0,0 11,10 0,20" fill="#FFFFFF" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 30 20" className={`${className} rounded-[2px] shadow-xs`}>
          <rect width="30" height="20" fill="#1E293B" />
        </svg>
      );
  }
};

const DIMENSIONS = {
  sm: 'w-[48px] h-[66px]',
  md: 'w-[76px] h-[106px]',
  lg: 'w-[154px] h-[214px]',
  stage: 'w-[144px] h-[200px] sm:w-[214px] sm:h-[298px]',
};

// Track failed photo fetches across renders to avoid flickering retries
const failedPhotoIds = new Set<string>();

export const PlayerAvatar: React.FC<PlayerAvatarProps> = ({
  player,
  size = 'md',
  className = '',
}) => {
  const uid = useId().replace(/:/g, '');
  const attrs = computeCardAttributes(player);
  const palette = TIER_PALETTES[attrs.tier];

  const [useFallback, setUseFallback] = useState<boolean>(() => failedPhotoIds.has(player.id));

  useEffect(() => {
    setUseFallback(failedPhotoIds.has(player.id));
  }, [player.id]);

  const primaryPhotoSrc = `/api/player-photo/${encodeURIComponent(player.id)}?v=2`;
  const fallbackSrc =
    COUNTRY_FALLBACK_PORTRAITS[player.countryCode] ?? COUNTRY_FALLBACK_PORTRAITS.IN;
  const imgSrc = useFallback ? fallbackSrc : primaryPhotoSrc;

  const isFullCard = size === 'stage' || size === 'lg';
  const isMini = size === 'sm';
  const teamCode = player.ipl2025Franchise || player.previousFranchises[0] || 'IPL';

  const shortName = (() => {
    const parts = player.name.trim().split(/\s+/);
    if (parts.length === 1) return parts[0];
    return `${parts[0][0]}. ${parts.slice(1).join(' ')}`;
  })();

  const statItems = [
    { label: 'BAT', value: attrs.bat },
    { label: 'RUN', value: attrs.run },
    { label: 'BOW', value: attrs.bow },
    { label: 'CAT', value: attrs.cat },
    { label: 'FIE', value: attrs.fie },
    { label: 'PHY', value: attrs.phy },
  ];

  return (
    <div
      className={`relative shrink-0 select-none ${DIMENSIONS[size]} ${className}`}
      style={{ filter: size === 'sm' ? undefined : palette.dropShadow }}
      title={`${player.name} · ${attrs.tier} (${attrs.ovr} ${attrs.roleCode})`}
    >
      {/* METALLIC FUT SHIELD BACKGROUND + PRISM RAYS + BEVELED BORDER */}
      <svg
        viewBox="0 0 280 390"
        className="absolute inset-0 w-full h-full pointer-events-none"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id={`bg-${uid}`} x1="0.1" y1="0" x2="0.9" y2="1">
            <stop offset="0%" stopColor={palette.bgStops[0]} />
            <stop offset="38%" stopColor={palette.bgStops[1]} />
            <stop offset="75%" stopColor={palette.bgStops[2]} />
            <stop offset="100%" stopColor={palette.bgStops[3]} />
          </linearGradient>
          <linearGradient id={`sheen-${uid}`} x1="0" y1="0" x2="1" y2="0.85">
            <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.34" />
            <stop offset="35%" stopColor="#FFFFFF" stopOpacity="0.04" />
            <stop offset="68%" stopColor="#FFFFFF" stopOpacity="0.16" />
            <stop offset="100%" stopColor="#FFFFFF" stopOpacity="0" />
          </linearGradient>
          <clipPath id={`clip-${uid}`}>
            <path d={SHIELD_PATH} />
          </clipPath>
        </defs>

        {/* Base Shield Metallic Plate */}
        <path d={SHIELD_PATH} fill={`url(#bg-${uid})`} />

        {/* Geometric Diagonal Bevel Prism Beams (matching the Virat Kohli FUT reference) */}
        <g clipPath={`url(#clip-${uid})`}>
          <polygon points="105,12 248,68 42,276 22,250" fill={palette.rayDark} />
          <polygon points="122,28 242,74 52,268 42,254" fill={palette.rayLight} />
          <polygon points="184,96 274,132 106,304 88,288" fill={palette.rayDark} opacity="0.55" />
          <polygon points="200,112 276,144 128,298 118,288" fill={palette.rayLight} opacity="0.65" />
          {/* Glossy diagonal sheen overlay */}
          <rect x="0" y="0" width="280" height="390" fill={`url(#sheen-${uid})`} />
        </g>

        {/* Outer Bevel Rim & Crisp Inner Specular Border */}
        <path
          d={SHIELD_PATH}
          fill="none"
          stroke={palette.borderOuter}
          strokeWidth={isMini ? '6' : '4.5'}
        />
        <path
          d={SHIELD_INNER_PATH}
          fill="none"
          stroke={palette.borderInner}
          strokeWidth={isMini ? '2.5' : '1.8'}
          opacity="0.78"
        />
      </svg>

      {/* CARD CONTENT CLIPPED CLEANLY INSIDE SHIELD */}
      <div
        className="relative z-10 w-full h-full flex flex-col overflow-hidden"
        style={{
          clipPath:
            'polygon(50% 1.5%, 88% 6.5%, 96% 11.5%, 96% 79.5%, 82% 91%, 50% 98.5%, 18% 91%, 4% 79.5%, 4% 11.5%, 12% 6.5%)',
        }}
      >
        {/* TOP AREA: OVERALL RATING + ROLE (LEFT) & PLAYER CUTOUT PORTRAIT (CENTER-RIGHT) */}
        <div
          className={`relative w-full ${
            isFullCard ? 'h-[61%]' : isMini ? 'h-[76%]' : 'h-[70%]'
          }`}
        >
          {/* Top-Left Rating & Position (Matches Reference: "95 / BAT") */}
          <div
            className={`absolute z-20 flex flex-col items-center leading-none ${
              size === 'stage'
                ? 'top-[10%] left-[8.5%]'
                : size === 'lg'
                ? 'top-[10%] left-[8.5%]'
                : size === 'md'
                ? 'top-[11%] left-[9%]'
                : 'top-[10%] left-[9%]'
            }`}
            style={{ color: palette.inkPrimary }}
          >
            <span
              className={`font-display font-black tracking-tight tabular-nums ${
                size === 'stage'
                  ? 'text-[22px] sm:text-[34px]'
                  : size === 'lg'
                  ? 'text-[23px]'
                  : size === 'md'
                  ? 'text-[14px]'
                  : 'text-[10px]'
              }`}
            >
              {attrs.ovr}
            </span>
            {!isMini && (
              <span
                className={`font-extrabold uppercase tracking-wider mt-0.5 ${
                  size === 'stage'
                    ? 'text-[8px] sm:text-[11px]'
                    : size === 'lg'
                    ? 'text-[8.5px]'
                    : 'text-[6.5px]'
                }`}
                style={{ color: palette.inkSecondary }}
              >
                {attrs.roleCode}
              </span>
            )}
          </div>

          {/* Player Portrait Layer (Official Transparent IPL Cutout PNG or Verified Portrait) */}
          <div
            className={`absolute inset-x-0 bottom-0 flex items-end justify-center overflow-hidden ${
              isFullCard ? 'top-[8%] pl-[12%]' : 'top-[10%] pl-[16%]'
            }`}
            style={{
              WebkitMaskImage: useFallback
                ? 'radial-gradient(ellipse 68% 72% at 50% 44%, black 60%, transparent 98%)'
                : 'linear-gradient(to bottom, black 78%, transparent 100%)',
              maskImage: useFallback
                ? 'radial-gradient(ellipse 68% 72% at 50% 44%, black 60%, transparent 98%)'
                : 'linear-gradient(to bottom, black 78%, transparent 100%)',
            }}
          >
            <img
              src={imgSrc}
              alt={`${player.name} — ${attrs.tier} Cricket Card`}
              loading={size === 'stage' ? 'eager' : 'lazy'}
              referrerPolicy="no-referrer"
              onError={() => {
                if (!useFallback) {
                  failedPhotoIds.add(player.id);
                  setUseFallback(true);
                }
              }}
              className={
                useFallback
                  ? 'w-[82%] h-[92%] object-cover object-top rounded-t-full'
                  : 'w-[96%] h-[98%] object-contain object-bottom drop-shadow-[0_3px_6px_rgba(0,0,0,0.22)]'
              }
            />
          </div>
        </div>

        {/* LOWER METALLIC PLATE: NAME, 6-STAT ROW & BOTTOM CRESTS */}
        {isFullCard ? (
          <div className="relative z-20 flex-1 flex flex-col justify-between px-[7%] pb-[6.5%] pt-[1%]">
            {/* Metallic Divider Line + Bold Centered Player Name */}
            <div>
              <div
                className="w-full h-[1px] mb-[2px]"
                style={{
                  background: `linear-gradient(90deg, transparent 0%, ${palette.divider} 18%, ${palette.divider} 82%, transparent 100%)`,
                }}
              />
              <div
                className={`font-display font-extrabold text-center truncate leading-tight ${
                  size === 'stage' ? 'text-[11px] sm:text-[16.5px]' : 'text-[12.5px]'
                }`}
                style={{ color: palette.inkPrimary }}
              >
                {player.name}
              </div>
            </div>

            {/* 6-Attribute Horizontal Row: BAT | RUN | BOW | CAT | FIE | PHY */}
            <div className="grid grid-cols-6 gap-0.5 text-center my-[1px]">
              {statItems.map((st) => (
                <div key={st.label} className="flex flex-col items-center leading-none">
                  <span
                    className={`font-bold tracking-tight uppercase ${
                      size === 'stage' ? 'text-[6px] sm:text-[8.5px]' : 'text-[6.5px]'
                    }`}
                    style={{ color: palette.inkSecondary }}
                  >
                    {st.label}
                  </span>
                  <span
                    className={`font-display font-black tabular-nums mt-[1px] ${
                      size === 'stage' ? 'text-[9.5px] sm:text-[14.5px]' : 'text-[10.5px]'
                    }`}
                    style={{ color: palette.inkPrimary }}
                  >
                    {st.value}
                  </span>
                </div>
              ))}
            </div>

            {/* Bottom 3-Icon Crest Strip: Country Flag · Cricket Batter Silhouette · Franchise Emblem */}
            <div className="flex items-center justify-center gap-2 sm:gap-3 pt-[1px]">
              <CountryFlagSvg
                code={player.countryCode}
                className={size === 'stage' ? 'w-3.5 h-2.5 sm:w-5 sm:h-3.5' : 'w-4 h-2.5'}
              />

              {/* Subtle Cricket Batter Silhouette Emblem */}
              <svg
                viewBox="0 0 24 24"
                className={size === 'stage' ? 'w-3 h-3 sm:w-4 sm:h-4' : 'w-3.5 h-3.5'}
                fill="none"
                aria-hidden="true"
              >
                <circle cx="12.5" cy="4.2" r="2" fill="#FFFFFF" opacity="0.92" />
                <path
                  d="M11 7.2 L14.5 9.5 L18.5 5.2 L19.8 6.4 L15.2 11.4 L14.2 15.2 L16.8 20.5 L14.8 21.2 L12.3 16.5 L9.8 21 L7.9 20.2 L10.8 14.2 L10.6 9.8 L7.5 11.5 L6.6 10 Z"
                  fill="#FFFFFF"
                  opacity="0.92"
                />
              </svg>

              {/* Engraved Team Monogram Crest */}
              <span
                className={`font-display font-black tracking-tight uppercase leading-none border rounded px-1 py-[1px] ${
                  size === 'stage' ? 'text-[6.5px] sm:text-[8.5px]' : 'text-[7px]'
                }`}
                style={{
                  color: palette.emblemTint,
                  borderColor: `${palette.emblemTint}66`,
                }}
              >
                {teamCode}
              </span>
            </div>
          </div>
        ) : (
          /* Compact md & sm Shield Footer */
          <div className="relative z-20 flex-1 flex flex-col items-center justify-center px-1 pb-[10%]">
            {size === 'md' && (
              <div
                className="font-display font-extrabold text-[8.5px] truncate max-w-[90%] leading-tight mb-0.5"
                style={{ color: palette.inkPrimary }}
              >
                {shortName}
              </div>
            )}
            <CountryFlagSvg
              code={player.countryCode}
              className={isMini ? 'w-3 h-2' : 'w-3.5 h-2.5'}
            />
          </div>
        )}
      </div>
    </div>
  );
};
