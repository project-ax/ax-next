import type { ReactNode } from 'react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { BrandMark } from '../BrandMark';

interface Props {
  title: string;
  description?: string;
  children: ReactNode;
}

export function SetupShell({ title, description, children }: Props) {
  return (
    <div className="flex items-center justify-center min-h-screen p-6 bg-background">
      <Card className="w-full max-w-[460px]">
        <CardHeader className="items-center text-center gap-3 pb-4">
          <BrandMark word="ax" size="xl" />
          <CardTitle className="text-xl font-semibold tracking-[-0.012em]">
            {title}
          </CardTitle>
          {description !== undefined && (
            <CardDescription>{description}</CardDescription>
          )}
        </CardHeader>
        <CardContent className="pt-2">{children}</CardContent>
      </Card>
    </div>
  );
}
