export default async function Layout({
    children
}: {
    params: Promise<{ projectId: string }>
    children: React.ReactNode
}) {
    return children;
}