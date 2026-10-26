"use client";
import { LockClosedIcon } from "@heroicons/react/24/outline";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect } from "react";
import type { ProfileStatsResponse } from "@/app/api/users/[id]/stats/route";
import { api, useProfile } from "@/lib/client";
import type { Visibility } from "@/lib/social-rules";
import { Avatar } from "./Avatar";
import { AvatarEditor } from "./AvatarEditor";
import { FriendButtons } from "./FriendsView";
import { ListsView } from "./ListsView";
import { RpgProfile } from "./ProfilePrototypes";
import { ErrorBox, Segmented, Spinner } from "./ui";

// Профиль пользователя: RPG-характеристика (уровень, награды, атрибуты, жанры, зал славы, достижения,
// статистика) и списки ниже (чужие — только чтение). Видимость — для своего профиля.

const VIS_HINT: Record<Visibility, string> = {
  all: "Профиль и списки видят все пользователи сервера.",
  friends: "Профиль и списки видят только друзья.",
  private: "Профиль и списки не видит никто, кроме вас.",
};

export function ProfileView({ id }: { id: number }) {
  const { data: p, isLoading, error } = useProfile(id);
  const qc = useQueryClient();
  const { data: d, error: statsError } = useQuery({
    queryKey: ["profile-stats", id], queryFn: () => api<ProfileStatsResponse>(`/api/users/${id}/stats`), enabled: Boolean(p?.visible),
  });
  // Пришли по ссылке «#awards» / «#lists» — прокрутить, когда профиль отрисован
  useEffect(() => {
    if (d && window.location.hash) setTimeout(() => document.getElementById(window.location.hash.slice(1))?.scrollIntoView({ behavior: "smooth" }), 300);
  }, [d]);
  if (isLoading) return <div className="flex h-64 items-center justify-center"><Spinner className="h-8 w-8" /></div>;
  if (error || !p) return <ErrorBox error={error} />;

  const setVisibility = async (visibility: Visibility) => {
    qc.setQueryData(["profile", id], { ...p, visibility });
    await api("/api/me", { method: "PATCH", json: { visibility } });
    void qc.invalidateQueries({ queryKey: ["me"] });
  };
  const friend = !p.self && <FriendButtons userId={p.user.id} state={p.state} name={p.user.name} />;

  if (!p.visible) return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-5">
        <Avatar user={p.user} className="h-20 w-20 text-3xl" />
        <h1 className="min-w-0 flex-1 truncate text-2xl font-bold sm:text-3xl">{p.user.name}</h1>
        {friend}
      </div>
      <div className="flex flex-col items-center gap-3 rounded-xl bg-gray-800/40 py-16 text-center ring-1 ring-gray-700">
        <LockClosedIcon className="h-10 w-10 text-gray-500" />
        <p className="text-lg font-semibold">Профиль скрыт</p>
        <p className="max-w-md text-sm text-gray-400">
          {p.state === "friends" ? `${p.user.name} никому не показывает профиль.` : `${p.user.name} показывает профиль только друзьям.`}
        </p>
      </div>
    </div>
  );

  if (statsError) return <ErrorBox error={statsError} />;
  if (!d) return <div className="flex h-64 items-center justify-center"><Spinner className="h-8 w-8" /></div>;

  const extra = (
    <>
      {p.taste && (
        <div className="rounded-2xl bg-info-500/5 p-4 ring-1 ring-info-500/30">
          <p className="text-sm">
            Вкусы с вами совпадают на <b className="text-lg text-info-200">{p.taste.percent}%</b>
            <span className="ml-2 text-xs text-gray-400">
              {p.taste.agree !== null
                ? `оценки ${p.taste.common} общих тайтлов совпадают на ${p.taste.agree}%, плюс насколько любимое одного подходит другому`
                : "насколько любимое одного подходит другому (общих оценённых тайтлов пока мало)"}
            </span>
          </p>
          {p.taste.bothLiked.length > 0 && (
            <p className="mt-2 text-sm text-gray-300">
              Обоим понравилось:{" "}
              {p.taste.bothLiked.map((t, i) => (
                <span key={t.id}>{i > 0 && ", "}<Link href={`/anime/${t.id}`} className="text-accent-300 hover:text-accent-200">{t.title}</Link></span>
              ))}
            </p>
          )}
        </div>
      )}
      {p.self && p.visibility && (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-gray-800/40 p-4 ring-1 ring-gray-700">
          <span className="text-sm text-gray-300">Кто видит профиль</span>
          <Segmented value={p.visibility} onChange={setVisibility} options={[["all", "Все"], ["friends", "Друзья"], ["private", "Только я"]]} />
          <span className="text-xs text-gray-500">{VIS_HINT[p.visibility]} Отдельный тайтл можно скрыть в «Моих впечатлениях».</span>
        </div>
      )}
    </>
  );

  return (
    <div className="space-y-10">
      <RpgProfile user={p.user} d={d} self={p.self} actions={friend || undefined} extra={extra}
        avatar={p.self ? <AvatarEditor user={p.user} className="h-full w-full text-4xl" /> : undefined} />
      <section id="lists" className="scroll-mt-20">
        {p.self ? <ListsView /> : (
          <>
            <h2 className="mb-4 text-2xl font-bold">Списки</h2>
            <ListsView owner={p.user} />
          </>
        )}
      </section>
    </div>
  );
}
