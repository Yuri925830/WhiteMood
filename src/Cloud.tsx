import { brand } from './brand';

/** Standalone transparent mascot art derived from the approved WhiteMood IP. */
export default function Cloud({ className = '', sizes = '(max-width: 600px) 92vw, 600px', priority = false }: {
  className?: string;
  sizes?: string;
  priority?: boolean;
}) {
  return <picture className={`cloud-character ${className}`} aria-hidden="true">
    <source type="image/webp" srcSet={brand.cloudSources} sizes={sizes} />
    <img src={brand.cloudMaster} width={1484} height={1060} alt="" decoding="async" loading={priority ? 'eager' : 'lazy'} fetchPriority={priority ? 'high' : 'auto'} draggable={false} />
  </picture>;
}
