import { Card, CardContent, CardHeader } from '../Card';

export default function SkeletonSources() {
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="h-8 w-32 bg-muted rounded animate-pulse" />
        <div className="h-9 w-32 bg-muted rounded animate-pulse" />
      </div>

      {/* Sources table */}
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b">
                <tr>
                  {['名称', 'URL', '模式', 'Key', '分组', '状态', '并发', '权重', '额度', '统计', '操作'].map((_, i) => (
                    <th key={i} className="p-4 text-left">
                      <div className="h-4 w-12 bg-muted rounded animate-pulse" />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: 4 }).map((_, i) => (
                  <tr key={i} className="border-b">
                    <td className="p-4"><div className="h-4 w-24 bg-muted rounded animate-pulse" /></td>
                    <td className="p-4"><div className="h-4 w-32 bg-muted rounded animate-pulse" /></td>
                    <td className="p-4"><div className="h-5 w-16 bg-muted rounded animate-pulse" /></td>
                    <td className="p-4"><div className="h-4 w-20 bg-muted rounded animate-pulse" /></td>
                    <td className="p-4"><div className="h-4 w-16 bg-muted rounded animate-pulse" /></td>
                    <td className="p-4"><div className="h-5 w-12 bg-muted rounded animate-pulse" /></td>
                    <td className="p-4"><div className="h-4 w-16 bg-muted rounded animate-pulse" /></td>
                    <td className="p-4"><div className="h-4 w-8 bg-muted rounded animate-pulse" /></td>
                    <td className="p-4"><div className="h-4 w-20 bg-muted rounded animate-pulse" /></td>
                    <td className="p-4"><div className="h-4 w-20 bg-muted rounded animate-pulse" /></td>
                    <td className="p-4">
                      <div className="flex items-center gap-2">
                        <div className="h-7 w-8 bg-muted rounded animate-pulse" />
                        <div className="h-7 w-8 bg-muted rounded animate-pulse" />
                        <div className="h-7 w-12 bg-muted rounded animate-pulse" />
                        <div className="h-7 w-7 bg-muted rounded animate-pulse" />
                        <div className="h-7 w-7 bg-muted rounded animate-pulse" />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Models table header */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div className="h-6 w-24 bg-muted rounded animate-pulse" />
          <div className="h-8 w-24 bg-muted rounded animate-pulse" />
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b">
                <tr>
                  {Array.from({ length: 12 }).map((_, i) => (
                    <th key={i} className="p-4 text-left">
                      <div className="h-4 w-16 bg-muted rounded animate-pulse" />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i} className="border-b">
                    <td className="p-4"><div className="h-4 w-4 bg-muted rounded animate-pulse" /></td>
                    {Array.from({ length: 11 }).map((_, j) => (
                      <td key={j} className="p-4"><div className="h-4 w-16 bg-muted rounded animate-pulse" /></td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
