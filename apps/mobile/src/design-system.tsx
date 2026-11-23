import { ReactNode } from 'react';
import { Modal, Pressable, StyleSheet, Text, View, ViewStyle } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { brand } from './brand';

export const tokens = {
  colors: brand,
  spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 },
  radius: { sm: 8, md: 12, lg: 16, pill: 999 },
  touch: 48,
};

type IconName = 'check' | 'clock' | 'alert' | 'box' | 'map' | 'phone' | 'calendar' | 'settings' | 'plus' | 'chevron';
export function Icon({ name, color = brand.petroleum, size = 20 }: { name: IconName; color?: string; size?: number }) {
  const common = { fill: 'none' as const, stroke: color, strokeWidth: 1.9, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  return <Svg width={size} height={size} viewBox="0 0 24 24" accessibilityElementsHidden>
    {name === 'check' && <Path {...common} d="m5 12 4 4L19 6" />}
    {name === 'clock' && <><Circle {...common} cx="12" cy="12" r="8.5"/><Path {...common} d="M12 7v5l3 2"/></>}
    {name === 'alert' && <><Path {...common} d="m12 4 8 15H4L12 4Z"/><Path {...common} d="M12 9v4m0 3h.01"/></>}
    {name === 'box' && <><Path {...common} d="m4 8 8-4 8 4v9l-8 4-8-4V8Z"/><Path {...common} d="m4 8 8 4 8-4M12 12v9"/></>}
    {name === 'map' && <><Path {...common} d="m4 6 5-2 6 2 5-2v14l-5 2-6-2-5 2V6Z"/><Path {...common} d="M9 4v14m6-12v14"/></>}
    {name === 'phone' && <Path {...common} d="M7 4h3l1.2 4-2 1.5a14 14 0 0 0 5.3 5.3l1.5-2 4 1.2v3c0 1-1 2-2 2C11.4 19.5 4.5 12.6 4.5 6c0-1 1-2 2.5-2Z"/>}
    {name === 'calendar' && <><Path {...common} d="M5 5h14v15H5zM8 3v4m8-4v4M5 9h14"/><Path {...common} d="M8 13h.01m4 0h.01m4 0h.01m-8 3h.01m4 0h.01"/></>}
    {name === 'settings' && <><Circle {...common} cx="12" cy="12" r="3"/><Path {...common} d="m19 13 2-1-2-1a7 7 0 0 0-.6-1.5l.7-2-1.7-1-1.6 1A7 7 0 0 0 14 6l-.3-2h-2l-.3 2a7 7 0 0 0-1.8.7l-1.6-1-1.7 1 .7 2A7 7 0 0 0 6.4 11l-2 1 2 1c.1.5.3 1 .6 1.5l-.7 2 1.7 1 1.6-1c.6.3 1.2.6 1.8.7l.3 2h2l.3-2a7 7 0 0 0 1.8-.7l1.6 1 1.7-1-.7-2c.3-.5.5-1 .6-1.5Z"/></>}
    {name === 'plus' && <Path {...common} d="M12 5v14m-7-7h14"/>}
    {name === 'chevron' && <Path {...common} d="m9 6 6 6-6 6"/>}
  </Svg>;
}

export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) { return <View style={[styles.card, style]}>{children}</View>; }
export function StatusChip({ status, label }: { status: 'assigned'|'in_progress'|'completed'|'problem'|'overdue'|'pending'; label: string }) {
  const tone = status === 'completed' ? 'success' : status === 'problem' || status === 'overdue' ? 'danger' : status === 'assigned' ? 'info' : 'warning';
  return <View style={[styles.chip, styles[`chip_${tone}`]]}><Text style={[styles.chipText, styles[`chipText_${tone}`]]}>{label}</Text></View>;
}
export function PrimaryButton({ children, onPress, disabled = false }: { children: ReactNode; onPress?: () => void; disabled?: boolean }) { return <Pressable onPress={onPress} disabled={disabled} style={[styles.primary, disabled && styles.disabled]} accessibilityRole="button"><Text style={styles.primaryText}>{children}</Text></Pressable>; }
export function SecondaryButton({ children, onPress, disabled = false }: { children: ReactNode; onPress?: () => void; disabled?: boolean }) { return <Pressable onPress={onPress} disabled={disabled} style={[styles.secondary, disabled && styles.disabled]} accessibilityRole="button"><Text style={styles.secondaryText}>{children}</Text></Pressable>; }
export function EmptyState({ icon = 'box', title, message }: { icon?: IconName; title: string; message: string }) { return <View style={styles.empty}><Icon name={icon} size={28} color={brand.petroleum}/><Text style={styles.emptyTitle}>{title}</Text><Text style={styles.emptyMessage}>{message}</Text></View>; }
export function ConfirmModal({ visible, title, message, confirmLabel = 'Continuar', destructive = false, onCancel, onConfirm }: { visible: boolean; title: string; message: string; confirmLabel?: string; destructive?: boolean; onCancel: () => void; onConfirm: () => void }) {
  return <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}><View style={styles.confirmBackdrop}><View style={styles.confirmCard}><Text style={styles.confirmTitle}>{title}</Text><Text style={styles.confirmMessage}>{message}</Text><View style={styles.confirmActions}><Pressable style={styles.confirmSecondary} onPress={onCancel}><Text style={styles.confirmSecondaryText}>Cancelar</Text></Pressable><Pressable style={[styles.confirmPrimary, destructive && styles.confirmDanger]} onPress={onConfirm}><Text style={styles.confirmPrimaryText}>{confirmLabel}</Text></Pressable></View></View></View></Modal>;
}
export function Skeleton({ width = '100%', height = 18 }: { width?: number | `${number}%`; height?: number }) { return <View style={[styles.skeleton, { width, height }]} />; }
export function ProgressRing({ value, size = 76, stroke = 8 }: { value: number; size?: number; stroke?: number }) { const radius = (size - stroke) / 2; const circumference = 2 * Math.PI * radius; return <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}><Circle cx={size/2} cy={size/2} r={radius} stroke={brand.petroleumLight} strokeWidth={stroke} fill="none"/><Circle cx={size/2} cy={size/2} r={radius} stroke={brand.accent} strokeWidth={stroke} fill="none" strokeLinecap="round" strokeDasharray={`${circumference} ${circumference}`} strokeDashoffset={circumference * (1 - Math.min(100, Math.max(0, value)) / 100)} transform={`rotate(-90 ${size/2} ${size/2})`}/></Svg>; }

const styles = StyleSheet.create({
  card: { backgroundColor: 'white', borderRadius: 16, borderWidth: 1, borderColor: brand.border, padding: 16 },
  primary: { minHeight: 48, borderRadius: 11, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: brand.petroleum },
  primaryText: { color: 'white', fontFamily: 'Inter_600SemiBold', fontSize: 14 },
  secondary: { minHeight: 48, borderRadius: 11, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: brand.petroleumLight },
  secondaryText: { color: brand.petroleum, fontFamily: 'Inter_600SemiBold', fontSize: 14 },
  disabled: { opacity: .55 },
  chip: { minHeight: 28, borderRadius: 999, paddingHorizontal: 10, alignItems: 'center', justifyContent: 'center' },
  chip_info: { backgroundColor: '#E6F1F3' }, chip_success: { backgroundColor: '#E5F3EC' }, chip_warning: { backgroundColor: '#FFF0DF' }, chip_danger: { backgroundColor: '#FDEAE7' },
  chipText: { fontFamily: 'Inter_600SemiBold', fontSize: 11 }, chipText_info: { color: brand.petroleum }, chipText_success: { color: brand.success }, chipText_warning: { color: brand.warning }, chipText_danger: { color: brand.danger },
  empty: { backgroundColor: 'white', borderRadius: 16, borderWidth: 1, borderColor: brand.border, padding: 24, alignItems: 'center', gap: 8, marginTop: 20 }, emptyTitle: { fontFamily: 'Inter_600SemiBold', color: brand.text, fontSize: 15, textAlign: 'center' }, emptyMessage: { fontFamily: 'Inter_400Regular', color: brand.muted, fontSize: 12, lineHeight: 18, textAlign: 'center' },
  skeleton: { backgroundColor: '#E7EEF0', borderRadius: 8, marginVertical: 5 },
  confirmBackdrop: { flex: 1, backgroundColor: '#072A3588', justifyContent: 'center', padding: 22 },
  confirmCard: { backgroundColor: 'white', borderRadius: 20, padding: 20, gap: 12 },
  confirmTitle: { fontFamily: 'Inter_600SemiBold', color: brand.text, fontSize: 18 },
  confirmMessage: { fontFamily: 'Inter_400Regular', color: brand.muted, fontSize: 13, lineHeight: 19 },
  confirmActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 6 },
  confirmSecondary: { minHeight: 48, borderRadius: 11, paddingHorizontal: 15, justifyContent: 'center', backgroundColor: brand.petroleumLight },
  confirmSecondaryText: { fontFamily: 'Inter_600SemiBold', color: brand.petroleum, fontSize: 13 },
  confirmPrimary: { minHeight: 48, borderRadius: 11, paddingHorizontal: 15, justifyContent: 'center', backgroundColor: brand.petroleum },
  confirmDanger: { backgroundColor: brand.danger },
  confirmPrimaryText: { fontFamily: 'Inter_600SemiBold', color: 'white', fontSize: 13 },
});
