import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export function SkillsTab() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Skills</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">Loading...</p>
      </CardContent>
    </Card>
  );
}
