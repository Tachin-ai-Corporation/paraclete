// dashboard/app/work/[id]/page.jsx: one mission, checkpoint or task (components/work/WorkDetail.jsx).
// Keyed by id, so moving from one piece of work to another starts a fresh view.
import { WorkDetail } from '@/components/work/WorkDetail.jsx';

export default async function Page({ params }) {
  const { id } = await params;
  return <WorkDetail key={id} id={id} />;
}
