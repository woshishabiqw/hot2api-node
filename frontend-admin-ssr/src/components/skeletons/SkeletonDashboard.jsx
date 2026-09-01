import { Card, CardContent, CardHeader } from '../Card';

export default function SkeletonDashboard() {
  return (
    <div className="space-y-6">
      {/* Title */}
      <div className="h-8 w-32 bg-muted rounded animate-pulse" />

      {/* Stats cards (6 columns on lg, 2 on md, 1 on sm) */}
      <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
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

      {/* Concurrency card */}
      <Card>
        <CardHeader>
          <div className="h-5 w-32 bg-muted rounded animate-pulse" />
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="p-4 border rounded-lg space-y-2">
                <div className="flex items-center justify-between">
                  <div className="h-4 w-20 bg-muted rounded animate-pulse" />
                  <div className="h-3 w-16 bg-muted rounded animate-pulse" />
                </div>
                <div className="h-2 w-full bg-muted rounded-full animate-pulse" />
                <div className="h-3 w-24 bg-muted rounded animate-pulse" />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Trend chart */}
      <div className="grid gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div className="h-5 w-32 bg-muted rounded animate-pulse" />
            <div className="h-8 w-24 bg-muted rounded animate-pulse" />
          </CardHeader>
          <CardContent>
            <div className="h-[340px] w-full bg-muted rounded animate-pulse" />
          </CardContent>
        </Card>
      </div>

      {/* Pie chart + Source stats */}
      <div className="grid gap-4 grid-cols-1 md:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="h-5 w-32 bg-muted rounded animate-pulse" />
          </CardHeader>
          <CardContent>
            <div className="h-[360px] w-full bg-muted rounded animate-pulse" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div className="h-5 w-32 bg-muted rounded animate-pulse" />
            <div className="h-6 w-16 bg-muted rounded animate-pulse" />
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center justify-between">
                  <div className="h-4 w-24 bg-muted rounded animate-pulse" />
                  <div className="h-4 w-32 bg-muted rounded animate-pulse" />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Model ranking */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div className="h-5 w-40 bg-muted rounded animate-pulse" />
          <div className="h-6 w-16 bg-muted rounded animate-pulse" />
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="h-4 w-4 bg-muted rounded animate-pulse" />
                  <div className="h-4 w-48 bg-muted rounded animate-pulse" />
                </div>
                <div className="h-4 w-32 bg-muted rounded animate-pulse" />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
