import React from 'react';

export const MetalBackground = () => {
  return (
    <div className="absolute inset-0 pointer-events-none z-[0] bg-[#a8aeb8] overflow-hidden">
      {/* 1. Base brushed metal gradient */}
      <div className="absolute inset-0 bg-gradient-to-br from-[#d1d5db] via-[#9ca3af] to-[#6b7280] opacity-90" />
      
      {/* 2. Stainless Steel noise & slight brushed effect + faint grunge */}
      <div 
        className="absolute inset-0 opacity-40 mix-blend-multiply"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='400'%3E%3Cfilter id='metal'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.005 0.8' numOctaves='3' result='noise1' stitchTiles='stitch'/%3E%3CfeColorMatrix type='matrix' values='1 0 0 0 0, 1 0 0 0 0, 1 0 0 0 0, 0 0 0 0.8 0' in='noise1' result='brushed'/%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.04' numOctaves='2' result='noise2' stitchTiles='stitch'/%3E%3CfeColorMatrix type='matrix' values='0 0 0 0 0, 0 0 0 0 0, 0 0 0 0 0, 0 0 0 0.2 0' in='noise2' result='grunge'/%3E%3CfeMerge%3E%3CfeMergeNode in='brushed'/%3E%3CfeMergeNode in='grunge'/%3E%3C/feMerge%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23metal)'/%3E%3C/svg%3E")`,
          backgroundSize: '400px 400px',
        }}
      />
      
      {/* 3. Global metallic shine overlay */}
      <div className="absolute inset-0 bg-gradient-to-tr from-transparent via-[rgba(255,255,255,0.1)] to-transparent opacity-50" />
      
      {/* 4. Panel edges lighting / shadowing */}
      <div className="absolute inset-0 shadow-[inset_0_0_80px_rgba(0,0,0,0.6)]" />

      
      
      
      
      
    </div>
  );
};


