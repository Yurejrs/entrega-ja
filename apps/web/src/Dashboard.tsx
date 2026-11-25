import {ArrowRight, CalendarDays, CheckCircle2, Package, TrendingUp} from 'lucide-react';
import {DashboardMaps} from './Actions';

type Period = 'day' | 'week' | 'month';
type DashboardData = {
  summary?: Record<Period, number>;
  comparison?: Record<Period, number>;
  series?: {items: {label: string; count: number}[]};
  byStatus?: Record<string, number>;
  unseen?: number;
};

const statuses = [
  {key:'completed', label:'Concluída'},
  {key:'in_progress', label:'Em rota'},
  {key:'assigned', label:'Atribuída'},
  {key:'pending', label:'Pendente'},
] as const;

export function Dashboard({data,period,onPeriodChange,onManageDeliveries}:{data:DashboardData;period:Period;onPeriodChange:(value:Period)=>void;onManageDeliveries:()=>void}){
  const byStatus=data.byStatus??{};
  const total=Object.values(byStatus).reduce((sum,value)=>sum+Number(value||0),0);
  const completion=total?Math.round(100*Number(byStatus.completed??0)/total):0;
  const metrics=[
    {label:'Criadas hoje',value:data.summary?.day??0,subtitle:'Entregas criadas hoje',icon:Package,tone:'teal',comparison:'day'},
    {label:'Esta semana',value:data.summary?.week??0,subtitle:'Volume acumulado na semana',icon:TrendingUp,tone:'blue',comparison:'week'},
    {label:'Este mês',value:data.summary?.month??0,subtitle:'Volume acumulado no mês',icon:CalendarDays,tone:'violet',comparison:'month'},
    {label:'Concluídas (Total)',value:Number(byStatus.completed??0),subtitle:`${completion.toLocaleString('pt-BR',{minimumFractionDigits:1,maximumFractionDigits:1})}% de taxa de entrega`,icon:CheckCircle2,tone:'green',comparison:null},
  ] as const;
  function variation(key:Period){const previous=data.comparison?.[key];if(previous===undefined)return null;const current=Number(data.summary?.[key]??0);if(previous===0)return current===0?'Sem variação':'Novas entregas';const change=Math.round((current-previous)/previous*100);return `${change>0?'+':''}${change}% vs período anterior`}
  const weekRange=(()=>{const now=new Date();const monday=new Date(now);monday.setDate(now.getDate()-((now.getDay()+6)%7));const sunday=new Date(monday);sunday.setDate(monday.getDate()+6);const short=(date:Date)=>`${String(date.getDate()).padStart(2,'0')}/${String(date.getMonth()+1).padStart(2,'0')}`;return `${short(monday)} a ${short(sunday)}`})();
  const points=data.series?.items??[];
  const max=Math.max(1,...points.map(point=>point.count));
  return <div className="dashboard-page">
    <div className="dashboard-heading"><div><h2>Visão da operação</h2><p>Indicadores e acompanhamento das entregas</p></div><label>Período<select aria-label="Período do gráfico" value={period} onChange={event=>onPeriodChange(event.target.value as Period)}><option value="day">Hoje</option><option value="week">Esta semana</option><option value="month">Este mês</option></select></label></div>
    <div className="kpi-grid">{metrics.map(metric=>{const Icon=metric.icon;const badge=metric.comparison?variation(metric.comparison):null;return <article className="kpi-card" key={metric.label}><div className="kpi-copy"><span>{metric.label}</span><strong>{metric.value}</strong>{badge?<small className="kpi-variation">{badge}</small>:<small>{metric.subtitle}</small>}</div><span className={`kpi-icon kpi-${metric.tone}`}><Icon size={20}/></span></article>})}</div>
    <DashboardMaps/>
    <div className="dashboard-bottom-grid"><section className="dashboard-chart"><div className="chart-heading"><div><h3>Ritmo de entregas</h3><p>{period==='day'?'Distribuição por faixa de horário (Hoje)':period==='week'?`Últimos dias da semana (${weekRange})`:'Consolidado por semana no mês'}</p></div><span>{Number(data.unseen??0)} aguardando visualização</span></div><div className="dashboard-bars" role="img" aria-label="Gráfico de entregas no período">{points.map((point,index)=><div className="dashboard-bar-column" key={`${point.label}-${index}`} title={`${point.label}: ${point.count} entregas`}><span>{point.count||''}</span><div className="dashboard-bar-track"><i style={{height:`${Math.max(4,point.count/max*100)}%`}}/></div><small>{period==='week'||(period==='day'?index%4===0:index%5===0||index===points.length-1)?point.label:''}</small></div>)}</div>{!points.length&&<p className="empty-hint">Ainda não há entregas neste período.</p>}</section><section className="status-funnel"><h3>Status da operação <small>{total} total</small></h3><p>Distribuição atual por etapa</p><div className="status-funnel-list">{statuses.map(status=>{const count=Number(byStatus[status.key]??0);return <div className={`status-funnel-row status-${status.key}`} key={status.key}><div><span>{status.label}</span><strong>{count}</strong></div><div className="progress-track"><i style={{width:`${total?count/total*100:0}%`}}/></div></div>})}</div><button className="manage-deliveries" type="button" onClick={onManageDeliveries}>Gerenciar todas as entregas <ArrowRight size={14} aria-hidden="true"/></button></section></div>
  </div>;
}
