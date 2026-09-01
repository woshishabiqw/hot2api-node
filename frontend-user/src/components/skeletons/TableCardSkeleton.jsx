import { Card, CardContent, CardHeader } from '../Card';

export default function TableCardSkeleton({ rows = 5, className = '' }) {
  return (
    <Card className={className}>
      <CardHeader>
        <div className="h-5 w-24 bg-muted rounded animate-pulse" />
      </CardHeader>
      <CardContent className="p-0">
        <div className="p-4 space-y-3">
          {Array.from({ length: rows }).map((_, i) => (
            <div key={i} className="h-10 w-full bg-muted rounded animate-pulse" />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
