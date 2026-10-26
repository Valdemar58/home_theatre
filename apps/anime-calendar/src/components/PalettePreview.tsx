"use client";
import { Badge, Button, cx, TONE_CLASS, type Tone } from "./ui";

// Палитра приложения: тона, шкалы, варианты и состояния — чтобы цвета брать отсюда, а не придумывать.

const TONES: [Tone, string, string][] = [
  ["accent", "Акцент", "основные действия, выбранное, ссылки"],
  ["special", "Особое", "финалы, друзья, редкое"],
  ["positive", "Успех", "готово, рекомендую, высокий прогноз"],
  ["negative", "Опасность", "удалить, не рекомендую, ошибка"],
  ["warning", "Внимание", "спойлер, ожидание, общий список"],
  ["info", "Сведения", "озвучки, подсказки, похожесть"],
  ["neutral", "Нейтральный", "служебное, неактивное"],
];
const STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];

export function PalettePreview() {
  return (
    <div className="max-w-6xl space-y-10">
      <div>
        <h1 className="text-2xl font-bold sm:text-3xl">Палитра</h1>
        <p className="mt-1 max-w-3xl text-sm text-gray-400">
          Цвет выбирается по смыслу (тон), а вид — вариантом: мягкий, сплошной, контур, текст. Наведение и неактивное состояние
          выводятся из тона формулой (неактивное — смесь с нейтральным), отдельные цвета для них не нужны.
          В коде: <code className="text-gray-300">&lt;Badge tone=&quot;negative&quot;&gt;</code>, <code className="text-gray-300">className=&quot;tone-info soft&quot;</code>, <code className="text-gray-300">text-positive-300</code>.
        </p>
      </div>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Шкалы</h2>
        {TONES.map(([t, name]) => (
          <div key={t} className="flex items-center gap-3">
            <span className="w-28 shrink-0 text-sm text-gray-300">{name}</span>
            <div className="grid flex-1 grid-cols-11 overflow-hidden rounded-lg">
              {STEPS.map((k) => <div key={k} className="h-9" style={{ background: `var(--color-${t}-${k})` }} title={`${t}-${k}`} />)}
            </div>
          </div>
        ))}
        <div className="flex items-center gap-3 text-[10px] text-gray-500">
          <span className="w-28 shrink-0" />
          <div className="grid flex-1 grid-cols-11">{STEPS.map((k) => <span key={k} className="text-center">{k}</span>)}</div>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Варианты и состояния</h2>
        <div className="overflow-x-auto rounded-xl ring-1 ring-gray-700">
          <table className="w-full text-sm">
            <thead className="bg-gray-800/60 text-left text-xs text-gray-400">
              <tr><th className="p-3">Тон</th><th className="p-3">Мягкий</th><th className="p-3">Сплошной</th><th className="p-3">Контур</th><th className="p-3">Текст</th><th className="p-3">Неактивно</th></tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {TONES.map(([t, name, use]) => (
                <tr key={t}>
                  <td className="p-3"><p className="font-medium">{name}</p><p className="text-xs text-gray-500">{use}</p></td>
                  <td className="p-3"><Badge tone={t}>Бейдж</Badge></td>
                  <td className="p-3"><Badge tone={t} variant="solid">Бейдж</Badge></td>
                  <td className="p-3"><Badge tone={t} variant="outline">Бейдж</Badge></td>
                  <td className="p-3"><span className={cx("font-medium tone-text", TONE_CLASS[t])}>Текст тона</span></td>
                  <td className="p-3">
                    <span className="flex gap-2">
                      <button disabled className={cx("h-7 rounded-lg px-2.5 text-xs font-medium soft", TONE_CLASS[t])}>Мягкая</button>
                      <button disabled className={cx("h-7 rounded-lg px-2.5 text-xs font-medium solid", TONE_CLASS[t])}>Сплошная</button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Кнопки (наведите)</h2>
        <div className="flex flex-wrap gap-3">
          <Button variant="primary">Главная</Button>
          <Button>Обычная</Button>
          <Button variant="success">Успех</Button>
          <Button variant="danger">Удалить</Button>
          <Button variant="ghost">Тихая</Button>
          <Button variant="primary" disabled>Неактивна</Button>
          <Button variant="danger" disabled>Неактивна</Button>
        </div>
      </section>
    </div>
  );
}
