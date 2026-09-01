export default function CitationDot({ index, source }) {
  const baseClass =
    'inline-flex items-center justify-center w-4 h-4 rounded-full border text-[10px] font-medium align-super mx-0.5 transition-colors';
  if (!source?.url) {
    return (
      <span
        className={`${baseClass} border-muted-foreground text-muted-foreground bg-transparent`}
        style={{ transform: 'scale(0.8)' }}
      >
        {index}
      </span>
    );
  }
  return (
    <a
      href={source.url}
      target="_blank"
      rel="noopener noreferrer"
      title={`来源 ${index}：${source.title || source.url}`}
      className={`${baseClass} border-primary text-primary bg-transparent hover:bg-primary/10`}
      style={{ transform: 'scale(0.8)' }}
      onClick={(e) => e.stopPropagation()}
    >
      {index}
    </a>
  );
}
