import { Card, CardContent } from '../Card';

export default function SkeletonUsers() {
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="h-8 w-32 bg-muted rounded animate-pulse" />
        <div className="h-9 w-32 bg-muted rounded animate-pulse" />
      </div>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b">
                <tr>
                  {['用户名', '角色', '余额', '状态', '创建时间', '操作'].map((_, i) => (
                    <th key={i} className="p-4 text-left">
                      <div className="h-4 w-16 bg-muted rounded animate-pulse" />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i} className="border-b">
                    <td className="p-4"><div className="h-4 w-24 bg-muted rounded animate-pulse" /></td>
                    <td className="p-4"><div className="h-5 w-16 bg-muted rounded animate-pulse" /></td>
                    <td className="p-4"><div className="h-4 w-20 bg-muted rounded animate-pulse" /></td>
                    <td className="p-4"><div className="h-5 w-12 bg-muted rounded animate-pulse" /></td>
                    <td className="p-4"><div className="h-4 w-24 bg-muted rounded animate-pulse" /></td>
                    <td className="p-4">
                      <div className="flex items-center gap-2">
                        <div className="h-7 w-16 bg-muted rounded animate-pulse" />
                        <div className="h-7 w-12 bg-muted rounded animate-pulse" />
                        <div className="h-7 w-12 bg-muted rounded animate-pulse" />
                        <div className="h-7 w-8 bg-muted rounded animate-pulse" />
                      </div>
                    </td>
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
