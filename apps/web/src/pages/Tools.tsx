import { Link } from 'react-router-dom';
import Icon from '@mdi/react';
import { mdiEye, mdiChevronRight } from '@mdi/js';
import { AppShell } from '@/components/AppShell';

type ToolEntry = {
  to: string;
  title: string;
  blurb: string;
  icon: string;
};

const TOOLS: ToolEntry[] = [
  {
    to: '/tools/vision',
    title: 'Vision Trainer',
    blurb: 'Blindfold piece vision. A move is announced in algebraic notation — picture it mentally, then identify which pieces see a target square in the position you imagined. The board stays frozen until you\'ve held several moves in your head.',
    icon: mdiEye,
  },
];

export default function Tools() {
  return (
    <AppShell>
      <div className="flex-1 p-6 lg:p-10 max-w-3xl mx-auto w-full">
        <div className="mb-8">
          <h1 className="text-content-primary text-2xl font-semibold">Tools</h1>
          <p className="text-content-secondary text-sm mt-1">
            Drills and utilities for the rest of your chess training.
          </p>
        </div>

        <div className="flex flex-col gap-3">
          {TOOLS.map((t) => (
            <Link
              key={t.to}
              to={t.to}
              className="group bg-bg-surface border border-border rounded-2xl p-5 hover:border-accent/40 transition-colors flex items-start gap-4"
            >
              <div className="w-10 h-10 rounded-xl bg-accent/10 text-accent flex items-center justify-center shrink-0">
                <Icon path={t.icon} size={0.9} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <h2 className="text-content-primary font-semibold">{t.title}</h2>
                </div>
                <p className="text-content-secondary text-sm mt-1 leading-6">{t.blurb}</p>
              </div>
              <Icon
                path={mdiChevronRight}
                size={0.85}
                className="text-content-muted group-hover:text-accent transition-colors shrink-0 mt-1"
              />
            </Link>
          ))}
        </div>
      </div>
    </AppShell>
  );
}
