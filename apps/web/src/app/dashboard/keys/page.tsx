'use client';

import { useEffect, useState } from 'react';
import { Plus, Copy, KeyRound, AlertTriangle, Trash2, Pencil } from 'lucide-react';
import { toast } from '@/components/ui/Sonner';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { Switch } from '@/components/ui/Switch';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/Dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/Table';
import { formatCredits } from '@/lib/marketplace/pricing-calc';

interface KeyRow {
  id: string;
  name: string;
  keyPrefix: string;
  costLimitMonthlyRub: string | null;
  modelWhitelist: string[];
  ruResidencyOnly: boolean;
  disabledAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export default function DashboardKeysPage() {
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create modal state
  const [openCreate, setOpenCreate] = useState(false);
  const [formName, setFormName] = useState('');
  const [formCost, setFormCost] = useState('');
  const [formRu, setFormRu] = useState(false);
  const [formWhitelist, setFormWhitelist] = useState('');
  const [creating, setCreating] = useState(false);

  // Show-key modal state
  const [shownKey, setShownKey] = useState<string | null>(null);

  // Edit modal state
  const [editing, setEditing] = useState<KeyRow | null>(null);
  const [editName, setEditName] = useState('');
  const [editCost, setEditCost] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);

  async function load() {
    try {
      setLoading(true);
      const res = await fetch('/api/dashboard/keys', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setKeys(data.keys || []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function handleCreate() {
    setError(null);
    setCreating(true);
    try {
      const body: Record<string, unknown> = {
        name: formName.trim(),
        ruResidencyOnly: formRu,
      };
      if (formCost.trim())
        body.costLimitMonthlyRub = Number(formCost.replace(/[^\d.]/g, ''));
      if (formWhitelist.trim()) {
        body.modelWhitelist = formWhitelist
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
      }

      const res = await fetch('/api/dashboard/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || `HTTP ${res.status}`);
        return;
      }
      setShownKey(data.key);
      setOpenCreate(false);
      setFormName('');
      setFormCost('');
      setFormRu(false);
      setFormWhitelist('');
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreating(false);
    }
  }

  async function handleDisable(id: string, disabled: boolean) {
    await fetch(`/api/dashboard/keys/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ disabled }),
    });
    await load();
  }

  async function handleDelete(id: string) {
    if (!confirm('Удалить API-ключ? Восстановить будет нельзя.')) return;
    await fetch(`/api/dashboard/keys/${id}`, { method: 'DELETE' });
    await load();
  }

  function openEdit(row: KeyRow) {
    setEditing(row);
    setEditName(row.name);
    setEditCost(row.costLimitMonthlyRub ?? '');
  }

  async function saveEdit() {
    if (!editing) return;
    setSavingEdit(true);
    try {
      const body: Record<string, unknown> = { name: editName.trim() };
      body.costLimitMonthlyRub = editCost.trim()
        ? Number(editCost.replace(/[^\d.]/g, ''))
        : null;
      const res = await fetch(`/api/dashboard/keys/${editing.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error || `HTTP ${res.status}`);
        return;
      }
      setEditing(null);
      await load();
    } finally {
      setSavingEdit(false);
    }
  }

  return (
    <>
      <section className="container mx-auto max-w-6xl px-4 py-10">
        <header className="mb-6 flex items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">API-ключи</h1>
            <p className="text-muted-foreground mt-1">
              Создавайте, ограничивайте и отзывайте ключи доступа к шлюзу AIAG.
            </p>
          </div>
          <Button leftIcon={<Plus className="h-4 w-4" />} onClick={() => setOpenCreate(true)}>
            Создать ключ
          </Button>
        </header>

        {error && (
          <div
            role="alert"
            className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </div>
        )}

        <Card>
          <CardContent className="p-0">
            {loading ? (
              <div className="px-6 py-12 text-center text-sm text-muted-foreground">
                Загрузка…
              </div>
            ) : keys.length === 0 ? (
              <EmptyState
                illustration="keys"
                title="Нет API-ключей"
                description="Создайте первый ключ чтобы начать делать запросы к API."
                icon={<KeyRound className="h-8 w-8" />}
                actionLabel="Создать ключ"
                actionOnClick={() => setOpenCreate(true)}
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Имя</TableHead>
                    <TableHead>Префикс</TableHead>
                    <TableHead>Лимит кр/мес</TableHead>
                    <TableHead>Создан</TableHead>
                    <TableHead>Использован</TableHead>
                    <TableHead>Статус</TableHead>
                    <TableHead className="text-right">Действия</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {keys.map((k) => {
                    const disabled = !!k.disabledAt;
                    return (
                      <TableRow key={k.id}>
                        <TableCell className="font-medium">{k.name}</TableCell>
                        <TableCell className="font-mono text-xs">
                          {k.keyPrefix}…
                        </TableCell>
                        <TableCell>
                          {k.costLimitMonthlyRub
                            ? formatCredits(Number(k.costLimitMonthlyRub))
                            : '—'}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {new Date(k.createdAt).toLocaleDateString('ru-RU')}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {k.lastUsedAt
                            ? new Date(k.lastUsedAt).toLocaleDateString('ru-RU')
                            : '—'}
                        </TableCell>
                        <TableCell>
                          {disabled ? (
                            <Badge variant="secondary">Отключён</Badge>
                          ) : (
                            <Badge className="bg-green-500/15 text-green-400 border-green-500/30 hover:bg-green-500/15">
                              Активен
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => openEdit(k)}
                              title="Редактировать"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleDisable(k.id, !disabled)}
                            >
                              {disabled ? 'Включить' : 'Отключить'}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleDelete(k.id)}
                              title="Удалить"
                            >
                              <Trash2 className="h-3.5 w-3.5 text-destructive" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </section>

      {/* Create modal */}
      <Dialog open={openCreate} onOpenChange={setOpenCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Создать API-ключ</DialogTitle>
            <DialogDescription>
              Настройте имя и опциональные ограничения. Полный ключ будет показан только один раз.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-2">
            <div>
              <Label htmlFor="name">Имя</Label>
              <Input
                id="name"
                placeholder="например, production-server"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                maxLength={100}
              />
            </div>
            <div>
              <Label htmlFor="cost">Лимит расходов (кр/мес, опционально)</Label>
              <Input
                id="cost"
                placeholder="например, 5000"
                inputMode="numeric"
                value={formCost}
                onChange={(e) => setFormCost(e.target.value)}
              />
            </div>
            <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
              <div>
                <Label htmlFor="ru" className="cursor-pointer">Только RU-резидентность</Label>
                <p className="text-xs text-muted-foreground">
                  Запросы только к российским upstream-провайдерам.
                </p>
              </div>
              <Switch id="ru" checked={formRu} onCheckedChange={setFormRu} />
            </div>
            <div>
              <Label htmlFor="wl">Whitelist моделей (через запятую, опционально)</Label>
              <Input
                id="wl"
                placeholder="gpt-4o-mini, claude-sonnet-4"
                value={formWhitelist}
                onChange={(e) => setFormWhitelist(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpenCreate(false)}>
              Отмена
            </Button>
            <Button onClick={handleCreate} disabled={!formName.trim() || creating}>
              {creating ? 'Создание…' : 'Создать'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Show key modal */}
      <Dialog open={!!shownKey} onOpenChange={(o) => !o && setShownKey(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-400" />
              Сохраните ключ
            </DialogTitle>
            <DialogDescription>
              Это единственный раз, когда мы показываем ключ полностью. Если потеряете — придётся создать новый.
            </DialogDescription>
          </DialogHeader>
          {shownKey && (
            <div className="rounded-md border border-border bg-muted/30 p-3 font-mono text-sm break-all">
              {shownKey}
            </div>
          )}
          <DialogFooter>
            <Button
              leftIcon={<Copy className="h-4 w-4" />}
              onClick={() => {
                if (shownKey) {
                  navigator.clipboard.writeText(shownKey);
                  toast.success('Ключ скопирован', { duration: 2000 });
                }
              }}
            >
              Скопировать
            </Button>
            <Button variant="ghost" onClick={() => setShownKey(null)}>
              Закрыть
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit modal */}
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Редактировать ключ</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 py-2">
            <div>
              <Label htmlFor="ename">Имя</Label>
              <Input
                id="ename"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                maxLength={100}
              />
            </div>
            <div>
              <Label htmlFor="ecost">Лимит кр/мес</Label>
              <Input
                id="ecost"
                inputMode="numeric"
                value={editCost}
                onChange={(e) => setEditCost(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              Отмена
            </Button>
            <Button onClick={saveEdit} disabled={savingEdit}>
              {savingEdit ? 'Сохранение…' : 'Сохранить'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
