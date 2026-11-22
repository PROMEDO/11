/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { HomeSettings, PricingPlan, Restaurant, Session, SiteSettings, ThemeSettings } from './types';
import {
  applyPlatformTypography,
  applyScopedTheme,
  fetchAuthMe,
  getHome,
  getItem,
  getPlans,
  getSession,
  getSite,
  getTheme,
  logoutFromServer,
  resolveRestaurantByIdOrSlug,
  seedInitialData,
  syncFromServer,
} from './utils/storage';
import { syncDashboardMotionFromSite } from './utils/dashboardMotion';
import {
  ParsedRoute,
  getDashboardTabPath,
  migrateLegacyHashToPath,
  normalizeRouteTarget,
  parsePathRoute,
} from './utils/router';
import { detectClientSubdomain } from './utils/businessDefaults';
import { checkAndNotifyPendingOrders, unlockBellAudio } from './utils/orderBell';
import { isRunningStandalone } from './hooks/usePWAInstall';
import { OfflineIndicator } from './components/DashboardPWAInstallPrompt';
import { trackPublicVisit } from './utils/visitorTracker';

const HomeView = lazy(() => import('./pages/Home').then((m) => ({ default: m.HomeView })));
const AuthView = lazy(() => import('./pages/Login').then((m) => ({ default: m.AuthView })));
const OnboardingView = lazy(() => import('./pages/Onboard').then((m) => ({ default: m.OnboardingView })));
const DashboardPage = lazy(() => import('./pages/dashboard').then((m) => ({ default: m.DashboardPage })));
const AdminView = lazy(() => import('./pages/Admin').then((m) => ({ default: m.AdminView })));
const PublicMenuView = lazy(() => import('./pages/CustomerMenu').then((m) => ({ default: m.PublicMenuView })));

const RouteSuspenseFallback = () => (
  <div
    style={{
      minHeight: '100dvh',
      display: 'grid',
      placeItems: 'center',
      background: 'var(--bg, #f8fafc)',
    }}
    aria-hidden="true"
  >
    <div
      style={{
        width: '32px',
        height: '32px',
        borderRadius: '50%',
        border: '3px solid var(--line, rgba(15, 23, 42, 0.12))',
        borderTopColor: 'var(--brand, #059669)',
        animation: 'spin 0.7s linear infinite',
      }}
    />
  </div>
);

declare global {
  interface Window {
    __MENUPLUS_SUBDOMAIN__?: {
      subdomain: string;
      restaurantId: string;
      name: string;
      baseDomain: string;
    };
  }
}

export default function App() {
  const [route, setRoute] = useState<ParsedRoute>(() => {
    migrateLegacyHashToPath();
    return parsePathRoute(window.location.pathname);
  });
  const [session, setSessionState] = useState<Session | null>(() => getSession());
  const [site, setSite] = useState<SiteSettings>(getSite());
  const [home, setHome] = useState<HomeSettings>(getHome());
  const [plans, setPlans] = useState<PricingPlan[]>(getPlans());
  const [theme, setTheme] = useState<ThemeSettings>(getTheme());
  const [selectedPlanIndex, setSelectedPlanIndex] = useState<number>(0);
  const [subdomainRestaurantId, setSubdomainRestaurantId] = useState<string | null>(() => {
    return window.__MENUPLUS_SUBDOMAIN__?.restaurantId || null;
  });
  const [toastState, setToastState] = useState<{ id: number; text: string; isError: boolean } | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const [, setDataVersion] = useState<number>(0);

  const showToast = useCallback((msg: string) => {
    const cleanText = String(msg || '').replace(/\s*[✓✔️]+\s*$/g, '').trim();
    if (!cleanText) return;
    const isError = /🔒|تعذر|يرجى|ليست|ليس لديك|وصلت|يتجاوز|مستخدم بالفعل|يجب إكمال|توجد مشكلة|غير متاح|Unable|Error|Please|Invalid|Required|Forbidden|Limit|Already|Incomplete|Unavailable|نەتوانرا|تکایە|هەڵە|ڕێگەپێنەدراو|پڕنەکراوە|ناگونجێت/i.test(cleanText);
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
    const toastId = Date.now();
    setToastState({ id: toastId, text: cleanText, isError });
    const durationMs = /طلب جديد|طلبات جديدة/.test(cleanText) ? 4500 : 3000;
    toastTimerRef.current = window.setTimeout(() => {
      toastTimerRef.current = null;
      setToastState((cur) => (cur && cur.id === toastId ? null : cur));
    }, durationMs);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current !== null) {
        window.clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  const refreshData = useCallback(() => {
    setSite(getSite());
    setHome(getHome());
    setPlans(getPlans());
    setTheme(getTheme());
    setDataVersion((v) => v + 1);
  }, []);

  const initialSyncDoneRef = useRef(false);

  const applyGuardedRoute = useCallback(
    (pathname: string, search: string, options: { isInitial?: boolean; replaceUrl?: boolean } = {}) => {
      const parsed = parsePathRoute(pathname);
      const curSession = getSession();

      // Redirect /signup to /login
      if (parsed.page === 'signup') {
        window.history.replaceState(null, '', '/login');
        setRoute({ page: 'login', path: '/login' });
        return;
      }

      // PWA standalone launch: send user directly into dashboard (preserving last active branch)
      const isPwaSource =
        typeof window !== 'undefined' &&
        (isRunningStandalone() || new URLSearchParams(search || '').get('source') === 'pwa');

      if (parsed.page === 'home' && !parsed.scrollSection && !window.__MENUPLUS_SUBDOMAIN__ && isPwaSource) {
        if (curSession?.admin && curSession.menuLoggedOut && !curSession.rid) {
          window.history.replaceState(null, '', '/admin/home');
          setRoute({ page: 'admin', tab: 'home', path: '/admin/home' });
          return;
        }
        if (curSession?.rid) {
          const rid = curSession.rid;
          const curR = rid === 'demo' ? ({ done: 1 } as Restaurant) : getItem<Restaurant>(`restaurants/${rid}`);
          if (curR && curR.done === 1) {
            let savedBranch = '';
            try {
              savedBranch = window.localStorage.getItem(`mp_active_branch_${rid}`) || '';
            } catch {
              // ignore storage errors
            }
            const validBranch =
              savedBranch &&
              savedBranch !== rid &&
              getItem<Restaurant>(`restaurants/${savedBranch}`)?.parentRid === rid
                ? savedBranch
                : undefined;
            const dashPath = getDashboardTabPath('home', validBranch);
            window.history.replaceState(null, '', dashPath);
            setRoute({ page: 'dashboard', tab: 'home', branchId: validBranch, path: dashPath });
            return;
          }
          window.history.replaceState(null, '', '/onboard');
          setRoute({ page: 'onboard', path: '/onboard' });
          return;
        }
        try {
          window.sessionStorage.setItem('mp_post_login_path', '/dashboard/home');
        } catch {
          // ignore storage errors
        }
        window.history.replaceState(null, '', '/login');
        setRoute({ page: 'login', path: '/login' });
        return;
      }

      // Redirect already-authenticated users away from login
      if (parsed.page === 'login' && (curSession?.rid || curSession?.admin)) {
        if (curSession.admin && (!curSession.rid || curSession.menuLoggedOut)) {
          window.history.replaceState(null, '', '/admin/home');
          setRoute({ page: 'admin', tab: 'home', path: '/admin/home' });
          return;
        }
        const rid = (curSession.rid || curSession.personalRid || 'demo') as string;
        const curR = rid === 'demo' ? ({ done: 1 } as Restaurant) : getItem<Restaurant>(`restaurants/${rid}`);
        if (!curR || curR.done !== 1) {
          window.history.replaceState(null, '', '/onboard');
          setRoute({ page: 'onboard', path: '/onboard' });
          return;
        }
        let targetDashUrl = '';
        try {
          const pending = window.sessionStorage.getItem('mp_post_login_path') || '';
          if (pending.startsWith('/dashboard')) {
            window.sessionStorage.removeItem('mp_post_login_path');
            targetDashUrl = pending;
          }
        } catch {
          // ignore storage errors
        }
        if (!targetDashUrl) {
          let savedBranch = '';
          try {
            savedBranch = window.localStorage.getItem(`mp_active_branch_${rid}`) || '';
          } catch {
            // ignore storage errors
          }
          const validBranch =
            savedBranch &&
            savedBranch !== rid &&
            getItem<Restaurant>(`restaurants/${savedBranch}`)?.parentRid === rid
              ? savedBranch
              : undefined;
          targetDashUrl = getDashboardTabPath('home', validBranch);
        }
        const targetParsed = parsePathRoute(targetDashUrl);
        window.history.replaceState(null, '', targetDashUrl);
        if (targetParsed.page === 'dashboard') {
          setRoute(targetParsed);
        } else {
          setRoute({ page: 'dashboard', tab: 'home', path: '/dashboard/home' });
        }
        return;
      }

      // Guard dashboard & onboard routes
      if ((parsed.page === 'dashboard' || parsed.page === 'onboard') && !curSession?.rid && !curSession?.admin) {
        if (parsed.page === 'dashboard') {
          try {
            window.sessionStorage.setItem('mp_post_login_path', `${parsed.path}${search || ''}`);
          } catch {
            // ignore storage errors
          }
        }
        window.history.replaceState(null, '', '/login');
        setRoute({ page: 'login', path: '/login' });
        return;
      }

      if (parsed.page === 'dashboard' && curSession?.admin && curSession.menuLoggedOut && !curSession.rid) {
        window.history.replaceState(null, '', '/admin/home');
        setRoute({ page: 'admin', tab: 'home', path: '/admin/home' });
        return;
      }

      if (parsed.page === 'dashboard' && !curSession?.admin) {
        const rid = curSession?.rid as string;
        if (!rid) {
          try {
            window.sessionStorage.setItem('mp_post_login_path', `${parsed.path}${search || ''}`);
          } catch {
            // ignore storage errors
          }
          window.history.replaceState(null, '', '/login');
          setRoute({ page: 'login', path: '/login' });
          return;
        }
        if (rid !== 'demo') {
          const curR = getItem<Restaurant>(`restaurants/${rid}`);
          if (!curR || curR.done !== 1) {
            showToast('يجب إكمال معلومات وإعداد متجرك أولاً لتفعيل لوحة التحكم 🚀');
            window.history.replaceState(null, '', '/onboard');
            setRoute({ page: 'onboard', path: '/onboard' });
            return;
          }
        }
      }

      if (parsed.page === 'admin' && !curSession?.admin) {
        window.history.replaceState(null, '', '/login');
        setRoute({ page: 'login', path: '/login' });
        return;
      }

      if (parsed.page === 'menu') {
        const matched = resolveRestaurantByIdOrSlug(parsed.restaurantId);
        if (!matched) {
          if (parsed.isSlug && initialSyncDoneRef.current) {
            window.history.replaceState(null, '', '/');
            setRoute({ page: 'home', path: '/' });
            return;
          }
        } else if (!parsed.isSlug) {
          const canonicalSlug = matched.slug || (matched.id === 'demo' ? 'cap-burger' : matched.id);
          const targetPath = `/${canonicalSlug}`;
          const targetFull = `${targetPath}${search || ''}`;
          window.history.replaceState(null, '', targetFull);
          setRoute({ page: 'menu', restaurantId: canonicalSlug, isSlug: true, path: targetPath });
          if (!options.isInitial) {
            window.scrollTo({ top: 0, behavior: 'auto' });
            void syncFromServer().then((ok) => {
              if (ok && mountedRef.current) refreshData();
            });
          }
          return;
        }
      }

      if (options.replaceUrl) {
        const canonical = `${parsed.path}${search || ''}`;
        const currentFull = `${window.location.pathname}${window.location.search}`;
        if (currentFull !== canonical) {
          window.history.replaceState(null, '', canonical);
        }
      }

      setRoute(parsed);

      if (parsed.page === 'home' && parsed.scrollSection) {
        const sectionId = parsed.scrollSection;
        if (!options.isInitial) {
          void syncFromServer().then((ok) => {
            if (ok && mountedRef.current) refreshData();
          });
        }
        setTimeout(() => {
          document.getElementById(sectionId)?.scrollIntoView({ behavior: 'smooth' });
        }, 80);
        return;
      }

      if (!options.isInitial) {
        window.scrollTo({ top: 0, behavior: 'auto' });
        void syncFromServer().then((ok) => {
          if (ok && mountedRef.current) refreshData();
        });
      }
    },
    [refreshData, showToast]
  );

  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    fetchAuthMe()
      .catch(() => null)
      .then(() => seedInitialData())
      .then(async () => {
        if (!mountedRef.current) return;
        const curSite = getSite();
        setSessionState(getSession());
        refreshData();
        applyScopedTheme(window.location.pathname);
        const hostSub = window.__MENUPLUS_SUBDOMAIN__?.subdomain || detectClientSubdomain(curSite);
        if (hostSub) {
          const matched = resolveRestaurantByIdOrSlug(hostSub);
          if (matched?.id) {
            setSubdomainRestaurantId(matched.id);
          }
        }

        if (!mountedRef.current) return;
        initialSyncDoneRef.current = true;
        applyGuardedRoute(window.location.pathname, window.location.search, { isInitial: true, replaceUrl: true });
      });
    setSessionState(getSession());

    const handleThemeEvent = (e: any) => {
      if (e?.detail) {
        setTheme(e.detail);
      }
    };
    const handleSessionEvent = (e: any) => {
      if (mountedRef.current) {
        setSessionState(e?.detail ?? getSession());
      }
    };
    const handleDbUpdated = () => {
      if (mountedRef.current) refreshData();
    };
    const handlePopState = () => {
      applyGuardedRoute(window.location.pathname, window.location.search, { isInitial: false });
    };

    window.addEventListener('menuplus_theme_changed', handleThemeEvent);
    window.addEventListener('menuplus_session_changed', handleSessionEvent);
    window.addEventListener('menuplus_db_updated', handleDbUpdated);
    window.addEventListener('popstate', handlePopState);

    applyGuardedRoute(window.location.pathname, window.location.search, { isInitial: true, replaceUrl: true });

    return () => {
      mountedRef.current = false;
      window.removeEventListener('popstate', handlePopState);
      window.removeEventListener('menuplus_theme_changed', handleThemeEvent);
      window.removeEventListener('menuplus_session_changed', handleSessionEvent);
      window.removeEventListener('menuplus_db_updated', handleDbUpdated);
    };
  }, [applyGuardedRoute, refreshData]);

  const activeDashboardThemeMode =
    route.page === 'dashboard' && session?.rid
      ? getItem<Restaurant>(`restaurants/${session.rid}`)?.dashboardThemeMode
      : undefined;

  const activeOwnerRid = session?.rid
    ? session.rid
    : session?.admin && !session?.menuLoggedOut
    ? session.personalRid || 'demo'
    : '';
  const isStorefrontOrDashboardRoute =
    route.page === 'menu' ||
    route.page === 'dashboard' ||
    Boolean(subdomainRestaurantId && route.page === 'home');

  useEffect(() => {
    const handleUnlock = () => unlockBellAudio();
    window.addEventListener('pointerdown', handleUnlock, { passive: true });
    window.addEventListener('keydown', handleUnlock, { passive: true });
    window.addEventListener('touchstart', handleUnlock, { passive: true });
    window.addEventListener('click', handleUnlock, { passive: true });
    return () => {
      window.removeEventListener('pointerdown', handleUnlock);
      window.removeEventListener('keydown', handleUnlock);
      window.removeEventListener('touchstart', handleUnlock);
      window.removeEventListener('click', handleUnlock);
    };
  }, []);

  useEffect(() => {
    if (!activeOwnerRid || !isStorefrontOrDashboardRoute) return;
    let active = true;
    const isDash = route.page === 'dashboard';

    const evaluateNow = () => {
      if (!active || !initialSyncDoneRef.current) return;
      checkAndNotifyPendingOrders(activeOwnerRid, showToast, { isDashboardRoute: isDash });
    };

    const pollServerOrders = async () => {
      if (!active || document.visibilityState === 'hidden') return;
      try {
        const ok = await syncFromServer();
        if (ok && active && mountedRef.current) {
          evaluateNow();
        }
      } catch {
        // ignore transient background poll errors
      }
    };

    const handleDbOrStorage = () => {
      evaluateNow();
    };

    const handleWake = () => {
      if (document.visibilityState !== 'hidden') {
        void pollServerOrders();
      }
    };

    // Immediate evaluation & initial server check
    evaluateNow();
    void pollServerOrders();

    // Only poll here on storefront/menu routes (DashboardContext already runs a 4s poll on dashboard)
    const intervalId = !isDash
      ? window.setInterval(() => {
          void pollServerOrders();
        }, 4000)
      : null;

    window.addEventListener('menuplus_db_updated', handleDbOrStorage);
    window.addEventListener('storage', handleDbOrStorage);
    window.addEventListener('focus', handleWake);
    document.addEventListener('visibilitychange', handleWake);

    return () => {
      active = false;
      if (intervalId !== null) window.clearInterval(intervalId);
      window.removeEventListener('menuplus_db_updated', handleDbOrStorage);
      window.removeEventListener('storage', handleDbOrStorage);
      window.removeEventListener('focus', handleWake);
      document.removeEventListener('visibilitychange', handleWake);
    };
  }, [activeOwnerRid, isStorefrontOrDashboardRoute, route.page, showToast]);

  useEffect(() => {
    const isLandingHome = !subdomainRestaurantId && route.page === 'home';
    if (!isLandingHome && typeof document !== 'undefined') {
      document.documentElement.dir = 'rtl';
      document.documentElement.lang = 'ar';
    }
    const isStorefront = route.page === 'menu' || Boolean(subdomainRestaurantId && route.page === 'home');
    if (isStorefront) {
      applyPlatformTypography(getTheme());
      return;
    }
    applyScopedTheme(window.location.pathname);
    syncDashboardMotionFromSite(site, window.location.pathname);

    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handleSchemeChange = () => {
      applyScopedTheme(window.location.pathname);
      setDataVersion((v) => v + 1);
    };
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', handleSchemeChange);
      return () => mq.removeEventListener('change', handleSchemeChange);
    }
    mq.addListener(handleSchemeChange);
    return () => mq.removeListener(handleSchemeChange);
  }, [
    route.page,
    subdomainRestaurantId,
    site.homeThemeMode,
    site.adminThemeMode,
    site.dashboardThemeMode,
    site.motionConfig,
    session?.rid,
    activeDashboardThemeMode,
    theme.font,
    theme.typography,
  ]);

  const handleNavigate = useCallback(
    (target: string) => {
      const normalized = normalizeRouteTarget(target);
      const [nextPathname, nextQuery] = normalized.split('?');
      const parsed = parsePathRoute(nextPathname);
      const curSession = getSession();

      if (parsed.page === 'dashboard' && curSession?.admin && curSession.menuLoggedOut && !curSession.rid) {
        window.history.pushState(null, '', '/admin/home');
        setRoute({ page: 'admin', tab: 'home', path: '/admin/home' });
        window.scrollTo({ top: 0, behavior: 'auto' });
        return;
      }

      // Strictly forbid accessing dashboard if store setup is incomplete
      if (parsed.page === 'dashboard' && !curSession?.admin) {
        const rid = curSession?.rid;
        if (!rid) {
          try {
            window.sessionStorage.setItem('mp_post_login_path', `${parsed.path}${nextQuery ? `?${nextQuery}` : ''}`);
          } catch {
            // ignore storage errors
          }
          window.history.pushState(null, '', '/login');
          setRoute({ page: 'login', path: '/login' });
          window.scrollTo({ top: 0, behavior: 'auto' });
          return;
        }
        if (rid !== 'demo') {
          const curR = getItem<Restaurant>(`restaurants/${rid}`);
          if (!curR || curR.done !== 1) {
            showToast('يجب إكمال معلومات وإعداد متجرك أولاً لتفعيل لوحة التحكم 🚀');
            window.history.pushState(null, '', '/onboard');
            setRoute({ page: 'onboard', path: '/onboard' });
            window.scrollTo({ top: 0, behavior: 'auto' });
            return;
          }
        }
      }

      if (parsed.page === 'admin' && !curSession?.admin) {
        window.history.pushState(null, '', '/login');
        setRoute({ page: 'login', path: '/login' });
        window.scrollTo({ top: 0, behavior: 'auto' });
        return;
      }

      const nextUrl = `${parsed.path}${nextQuery ? `?${nextQuery}` : ''}`;
      const currentFull = `${window.location.pathname}${window.location.search}`;

      if (currentFull === nextUrl) {
        if (parsed.page === 'home' && parsed.scrollSection) {
          document.getElementById(parsed.scrollSection)?.scrollIntoView({ behavior: 'smooth' });
        } else {
          window.scrollTo({ top: 0, behavior: 'auto' });
        }
        void syncFromServer().then((ok) => {
          if (ok && mountedRef.current) refreshData();
        });
        return;
      }

      window.history.pushState(null, '', nextUrl);
      applyGuardedRoute(parsed.path, nextQuery ? `?${nextQuery}` : '', { isInitial: false });
    },
    [applyGuardedRoute, refreshData, showToast]
  );

  const handleLogout = useCallback(async (forceFull = false) => {
    const cur = getSession();
    const shouldPartialMenuLogout = Boolean(!forceFull && cur?.admin && !cur.menuLoggedOut);
    if (shouldPartialMenuLogout) {
      const result = await logoutFromServer('menu');
      setSessionState(result.session);
      if (typeof window !== 'undefined') {
        if (window.location.pathname === '/') {
          window.location.reload();
        } else {
          window.location.href = '/';
        }
      }
      return;
    }

    await logoutFromServer('all');
    setSessionState(null);
    if (typeof window !== 'undefined') {
      if (window.location.pathname === '/') {
        window.location.reload();
      } else {
        window.location.href = '/';
      }
    }
  }, []);

  const isStorefrontRoute = route.page === 'menu' || Boolean(subdomainRestaurantId && route.page === 'home');

  useEffect(() => {
    if (typeof document === 'undefined' || route.page === 'dashboard') return;
    const manifestLink = document.querySelector('link[rel="manifest"]') as HTMLLinkElement | null;
    if (manifestLink && manifestLink.getAttribute('href') !== '/manifest.webmanifest') {
      manifestLink.setAttribute('href', '/manifest.webmanifest');
    }
    const appleTitle = document.querySelector('meta[name="apple-mobile-web-app-title"]');
    if (appleTitle && appleTitle.getAttribute('content') !== 'منيو بلس') {
      appleTitle.setAttribute('content', 'منيو بلس');
    }
  }, [route.page]);

  useEffect(() => {
    if (!initialSyncDoneRef.current) return;
    const isMenuRoute =
      route.page === 'menu' || Boolean(subdomainRestaurantId && route.page === 'home');
    const isSiteRoute = !subdomainRestaurantId && route.page === 'home';
    if (isMenuRoute) {
      trackPublicVisit('menu');
    } else if (isSiteRoute) {
      trackPublicVisit('site');
    }
  }, [route, subdomainRestaurantId]);

  syncDashboardMotionFromSite(site, route.path);

  return (
    <div className="min-h-screen">
      <OfflineIndicator />
      {/* Toast popup */}
      {toastState && (
        <div
          key={toastState.id}
          className={`toast${isStorefrontRoute ? ' is-top' : ''}`}
          dir="rtl"
          role="status"
          aria-live="polite"
        >
          <span className="toast-text">{toastState.text}</span>
          {!toastState.isError && (
            <span className="toast-check" aria-hidden="true">
              <Check size={10} strokeWidth={3} />
            </span>
          )}
        </div>
      )}

      <Suspense fallback={<RouteSuspenseFallback />}>
        {/* Subdomain storefront takes precedence on <storename>.menuplus.io/ */}
        {subdomainRestaurantId && route.page === 'home' && (
          <PublicMenuView
            restaurantId={subdomainRestaurantId}
            session={session}
            onNavigate={handleNavigate}
            showToast={showToast}
          />
        )}

        {/* Clean Path View Routing */}
        {!subdomainRestaurantId && route.page === 'home' && (
          <HomeView
            home={home}
            site={site}
            plans={plans}
            session={session}
            onSelectPlan={(idx) => setSelectedPlanIndex(idx)}
            onNavigate={handleNavigate}
            onLogout={handleLogout}
          />
        )}

        {(route.page === 'login' || route.page === 'signup' || route.page === 'forgot') && (
          <AuthView
            mode={route.page}
            site={site}
            plans={plans}
            selectedPlanIndex={selectedPlanIndex}
            onNavigate={handleNavigate}
            onLoginSuccess={(newSes) => {
              setSessionState(newSes);
              showToast('مرحباً بك!');
            }}
          />
        )}

        {route.page === 'onboard' && session?.rid && (
          <OnboardingView
            restaurantId={session.rid}
            site={site}
            onNavigate={handleNavigate}
            onRefresh={refreshData}
          />
        )}

        {route.page === 'dashboard' && (session?.rid || (session?.admin && !session?.menuLoggedOut)) && (
          <DashboardPage
            session={
              session.rid
                ? session
                : { ...session, personalRid: session.personalRid || 'demo', rid: session.personalRid || 'demo' }
            }
            plans={plans}
            site={site}
            initialSubTab={route.tab}
            initialBranchId={route.branchId}
            onNavigate={handleNavigate}
            onLogout={() => void handleLogout(false)}
            onRefresh={refreshData}
            showToast={showToast}
          />
        )}

        {route.page === 'admin' && session?.admin && (
          <AdminView
            session={session}
            site={site}
            home={home}
            plans={plans}
            theme={theme}
            initialSubTab={route.tab}
            onNavigate={handleNavigate}
            onLogout={() => void handleLogout(true)}
            onRefresh={refreshData}
            showToast={showToast}
          />
        )}

        {route.page === 'menu' && (() => {
          const resolvedRest = resolveRestaurantByIdOrSlug(route.restaurantId);
          const targetId = resolvedRest?.id || route.restaurantId;
          return (
            <PublicMenuView
              restaurantId={targetId}
              session={session}
              onNavigate={handleNavigate}
              showToast={showToast}
            />
          );
        })()}
      </Suspense>
    </div>
  );
}
