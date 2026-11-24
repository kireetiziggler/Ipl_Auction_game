import React from 'react';
import { FRANCHISE_MAP } from '../data/franchises';
import { FranchiseId } from '../engine/types';

interface FranchiseBadgeProps {
  franchiseId: FranchiseId;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
}

const SIZE_MAP = {
  xs: 'w-7 h-7 text-[10px]',
  sm: 'w-9 h-9 text-xs',
  md: 'w-11 h-11 text-sm',
  lg: 'w-14 h-14 text-base',
  xl: 'w-20 h-20 text-xl',
};

export const FranchiseBadge: React.FC<FranchiseBadgeProps> = ({
  franchiseId,
  size = 'md',
  className = '',
}) => {
  const f = FRANCHISE_MAP[franchiseId];
  return (
    <div
      className={`relative inline-flex items-center justify-center shrink-0 select-none ${SIZE_MAP[size]} ${className}`}
      title={f.name}
      aria-label={f.name}
    >
      <svg viewBox="0 0 64 64" className="w-full h-full drop-shadow-sm">
        <defs>
          <linearGradient id={`shield-${f.id}-${size}`} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor={f.primaryColor} />
            <stop offset="100%" stopColor={f.secondaryColor} />
          </linearGradient>
        </defs>
        <path
          d="M32 3 L57 12 V31 C57 46 46 56 32 61 C18 56 7 46 7 31 V12 Z"
          fill={`url(#shield-${f.id}-${size})`}
          stroke="rgba(255,255,255,0.28)"
          strokeWidth="2"
        />
        <path
          d="M32 8 L52 15.5 V31 C52 43 43 51.5 32 55.8 C21 51.5 12 43 12 31 V15.5 Z"
          fill="none"
          stroke="rgba(255,255,255,0.16)"
          strokeWidth="1"
        />
      </svg>
      <span
        className="absolute inset-0 flex items-center justify-center font-display font-extrabold tracking-wide leading-none"
        style={{
          color: '#FFFFFF',
          textShadow: '0 1px 4px rgba(0,0,0,0.75)',
        }}
      >
        {f.shortName}
      </span>
    </div>
  );
};
