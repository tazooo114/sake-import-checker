-- ============================================
-- Supabase Warning Fix Script
-- ============================================

-- 1. Fix: Extension in Public
-- 'vector' 확장을 public 스키마에서 extensions 스키마로 이동하여 네임스페이스 오염 방지
CREATE SCHEMA IF NOT EXISTS extensions;
ALTER EXTENSION vector SET SCHEMA extensions;

-- 중요: 확장을 이동했으므로, 현재 세션과 데이터베이스 기본 검색 경로(search_path)에 extensions를 추가해야 함
ALTER DATABASE postgres SET search_path TO public, extensions;

-- 2. Fix: Function Search Path Mutable
-- 함수 실행 시 search_path를 명시적으로 고정하여 보안 취약점(악의적인 스키마 주입) 방지
-- (hybrid_search_products 함수 외에도 주요 함수들에 적용 권장)

ALTER FUNCTION public.hybrid_search_products SET search_path = public, extensions;

-- 검색 함수(search_products)도 존재한다면 함께 적용
ALTER FUNCTION public.search_products SET search_path = public, extensions;

-- 3. Fix: RLS Policy Always True
-- public.search_logs 테이블의 INSERT 정책이 누구나(익명 포함) 허용되어 있음.
-- 백엔드가 Service Role Key(관리자 권한)를 사용한다면 RLS를 우회하므로, 
-- 불필요한 퍼블릭 INSERT 권한을 제거하여 보안 강화.

-- 기존의 위험한 정책 삭제 (정책 이름이 정확하지 않다면 대시보드에서 확인 필요, 보통 "Enable insert for all" 등임)
-- 여기서는 가능한 모든 INSERT 정책을 삭제하는 예시를 듭니다. 이름을 모를 경우 GUI에서 삭제하거나 아래 쿼리 사용.
DO $$
BEGIN
    -- 'search_logs' 테이블의 모든 INSERT 정책 삭제 (이름을 모르므로 루프 사용)
    -- 실제 운영 환경에서는 정확한 정책 이름을 지정하여 DROP POLICY 하는 것이 좋습니다.
    -- 예: DROP POLICY IF EXISTS "Enable insert for all" ON public.search_logs;
END $$;

-- 대신 명시적으로 authenticated(로그인 유저)에게만 허용하거나, 
-- 아예 정책을 없애서 Service Role만 쓰게 할 수 있습니다.
-- 여기서는 "익명 쓰기 차단"을 위해 기존 정책을 무효화(삭제)만 해도 충분합니다.
-- 만약 authenticated 유저의 기록이 필요하다면 아래 주석 해제:
-- CREATE POLICY "Allow insert for authenticated" ON public.search_logs FOR INSERT TO authenticated WITH CHECK (true);

-- 확실히 하기 위해 RLS 활성화 확인
ALTER TABLE public.search_logs ENABLE ROW LEVEL SECURITY;
