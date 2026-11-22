const labels: Record<string, string> = {
  pending: 'Pendente',
  assigned: 'Atribuída',
  in_progress: 'Em rota',
  problem: 'Problema registrado',
  completed: 'Concluída',
  cancelled: 'Cancelada',
};

export function deliveryStatusLabel(status: string): string {
  return labels[status] ?? status;
}
