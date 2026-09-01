import { Card, CardContent, CardHeader } from '../Card';

export default function CardSkeleton({ icon = true, rows = 1, className = '' }) {
  return (
    <Card className={className}>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <div className="h-4 w-20 bg-muted rounded animate-pulse" />
        {icon && <div className="h-4 w-4 bg-muted rounded animate-pulse" />}
      </CardHeader>
      <CardContent>
        <div className="h-8 w-24 bg-muted rounded animate-pulse mb-2" />
        {rows > 1 && (
          <div className="space-y-2">
            {Array.from({ length: rows - 1 }).map((_, i) => (
              <div key={i} className="h-3 w-32 bg-muted rounded animate-pulse" />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
