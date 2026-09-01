import { Card, CardContent, CardHeader } from '../Card';

export default function SkeletonDashboard() {
  return (
    <div className="space-y-6">
      {/* Title */}
      <div className="h-8 w-32 bg-muted rounded animate-pulse" />

      {/* Overview cards */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i}>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <div className="h-4 w-20 bg-muted rounded animate-pulse" />
              <div className="h-4 w-4 bg-muted rounded animate-pulse" />
            </CardHeader>
            <CardContent>
              <div className="h-8 w-24 bg-muted rounded animate-pulse mb-2" />
              <div className="h-3 w-32 bg-muted rounded animate-pulse" />
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Trend + Pie charts */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div className="h-5 w-32 bg-muted rounded animate-pulse" />
            <div className="h-8 w-24 bg-muted rounded animate-pulse" />
          </CardHeader>
          <CardContent>
            <div className="h-[300px] w-full bg-muted rounded animate-pulse" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <div className="h-5 w-24 bg-muted rounded animate-pulse" />
          </CardHeader>
          <CardContent>
            <div className="h-[300px] w-full bg-muted rounded animate-pulse" />
          </CardContent>
        </Card>
      </div>

      {/* Recent logs table */}
      <Card>
        <CardHeader>
          <div className="h-5 w-24 bg-muted rounded animate-pulse" />
        </CardHeader>
        <CardContent className="p-0">
          <div className="p-4 space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-10 w-full bg-muted rounded animate-pulse" />
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
