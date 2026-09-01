import { Card, CardContent, CardHeader } from '../Card';

export default function ChartCardSkeleton({ height = 300, hasSelect = false, className = '' }) {
  return (
    <Card className={className}>
      <CardHeader className={`flex flex-row items-center justify-between ${hasSelect ? '' : 'pb-2'}`}>
        <div className="h-5 w-32 bg-muted rounded animate-pulse" />
        {hasSelect && <div className="h-8 w-24 bg-muted rounded animate-pulse" />}
      </CardHeader>
      <CardContent>
        <div className="w-full bg-muted rounded animate-pulse" style={{ height }} />
      </CardContent>
    </Card>
  );
}
