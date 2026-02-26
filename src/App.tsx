import React, { useState, useEffect } from 'react';
import { Upload, FileSpreadsheet, Trash2, BarChart3, AlertCircle, User, ChevronRight, ChevronDown, History } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

interface Fault {
  name: string;
  count: number;
}

interface OwnerResult {
  owner: string;
  faults: Fault[];
  total: number;
}

interface Report {
  id: number;
  filename: string;
  created_at: string;
  summary: OwnerResult[];
  uploader_user: string | null;
  uploader_uid: number | null;
  uploader_ip: string | null;
  report_type: string | null;
}

interface RequesterUser {
  user: string;
  uid: number;
  ip: string;
  group: string;
  note: string;
  keycloak_id: string;
}

interface RequesterIdentity {
  client_ip: string | null;
  ip_source: string;
  user: RequesterUser | null;
}

interface UiConfig {
  alarm_warning_threshold: number;
}

const AGGREGATE_REPORT_TYPE = 'aggregate_latest_all';

export default function App() {
  const [reports, setReports] = useState<Report[]>([]);
  const [selectedReport, setSelectedReport] = useState<Report | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isAggregating, setIsAggregating] = useState(false);
  const [isLoadingReport, setIsLoadingReport] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [expandedOwners, setExpandedOwners] = useState<Record<string, boolean>>({});
  const [requester, setRequester] = useState<RequesterIdentity | null>(null);
  const [onlyMine, setOnlyMine] = useState(false);
  const [alarmWarningThreshold, setAlarmWarningThreshold] = useState(100);

  useEffect(() => {
    void fetchRequester();
    void fetchUiConfig();
    void fetchReports();
  }, []);

  const fetchRequester = async () => {
    try {
      const res = await fetch('/api/requester');
      if (res.ok) {
        const data = (await res.json()) as RequesterIdentity;
        setRequester(data);
      }
    } catch (err) {
      console.error('Failed to fetch requester identity', err);
    }
  };

  const fetchUiConfig = async () => {
    try {
      const res = await fetch('/api/ui-config');
      if (res.ok) {
        const data = (await res.json()) as UiConfig;
        if (Number.isFinite(data.alarm_warning_threshold) && data.alarm_warning_threshold > 0) {
          setAlarmWarningThreshold(Math.trunc(data.alarm_warning_threshold));
        }
      }
    } catch (err) {
      console.error('Failed to fetch ui config', err);
    }
  };

  const fetchReports = async () => {
    try {
      const res = await fetch('/api/reports');
      if (res.ok) {
        const data = (await res.json()) as Report[];
        setReports(data);
        if (data.length > 0) {
          const currentSelectedId = selectedReport?.id;
          const targetId = currentSelectedId && data.some((r) => r.id === currentSelectedId)
            ? currentSelectedId
            : data[0].id;
          await handleSelectReport(targetId);
        } else {
          setSelectedReport(null);
        }
      }
    } catch (err) {
      console.error('Failed to fetch reports', err);
    }
  };

  const handleSelectReport = async (id: number) => {
    setIsLoadingReport(true);
    try {
      const res = await fetch(`/api/reports/${id}`);
      if (!res.ok) {
        throw new Error('Failed to fetch report details');
      }
      const detail = (await res.json()) as Report;
      setSelectedReport(detail);
      setExpandedOwners({});
    } catch (err) {
      console.error('Failed to fetch selected report', err);
      alert('Failed to load report details.');
    } finally {
      setIsLoadingReport(false);
    }
  };

  const handleFileUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    
    const file = files[0];
    const formData = new FormData();
    formData.append('file', file);

    setIsUploading(true);
    try {
      const res = await fetch('/api/reports/analyze', {
        method: 'POST',
        body: formData,
      });

      if (res.ok) {
        const newReport = (await res.json()) as Report;
        setReports(prev => [newReport, ...prev.filter((r) => r.id !== newReport.id)]);
        setSelectedReport(newReport);
        setExpandedOwners({});
      } else {
        const data = await res.json().catch(() => ({}));
        alert(data.error || 'Upload failed. Please ensure file type is supported and archive contains alarm_local.csv.');
      }
    } catch (err) {
      console.error('Upload error', err);
      alert('An error occurred during upload.');
    } finally {
      setIsUploading(false);
    }
  };

  const handleDeleteReport = async (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm('Are you sure you want to delete this report?')) return;

    try {
      const res = await fetch(`/api/reports/${id}`, { method: 'DELETE' });
      if (res.ok) {
        const newReports = reports.filter(r => r.id !== id);
        setReports(newReports);
        if (selectedReport?.id === id) {
          if (newReports[0]) {
            await handleSelectReport(newReports[0].id);
          } else {
            setSelectedReport(null);
          }
        }
      }
    } catch (err) {
      console.error('Delete error', err);
    }
  };

  const handleAggregateLatest = async () => {
    setIsAggregating(true);
    try {
      const res = await fetch('/api/reports/aggregate-latest', { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail || 'Failed to aggregate latest reports.');
      }

      const aggregateReport = (await res.json()) as Report;
      setReports(prev => [
        aggregateReport,
        ...prev.filter(
          (report) =>
            report.id !== aggregateReport.id &&
            report.report_type !== AGGREGATE_REPORT_TYPE,
        ),
      ]);
      setSelectedReport(aggregateReport);
      setExpandedOwners({});
    } catch (err) {
      console.error('Aggregate latest error', err);
      alert(err instanceof Error ? err.message : 'Aggregate latest reports failed.');
    } finally {
      setIsAggregating(false);
    }
  };

  const toggleOwner = (owner: string) => {
    setExpandedOwners(prev => ({
      ...prev,
      [owner]: !prev[owner]
    }));
  };

  // Drag and drop handlers
  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFileUpload(e.dataTransfer.files);
    }
  };

  const isMyUploadedReport = (report: Report) => {
    if (requester?.user?.user) {
      return report.uploader_user === requester.user.user;
    }
    if (requester?.client_ip) {
      return report.uploader_ip === requester.client_ip;
    }
    return false;
  };

  const isAggregateReport = (report: Report) => report.report_type === AGGREGATE_REPORT_TYPE;

  const visibleReports = onlyMine
    ? reports.filter((report) => isAggregateReport(report) || isMyUploadedReport(report))
    : reports;
  const selectedIsAggregate = selectedReport ? isAggregateReport(selectedReport) : false;
  const totalFaults = selectedReport
    ? selectedReport.summary.reduce((acc, curr) => acc + curr.total, 0)
    : 0;
  const topOwner = selectedReport && selectedReport.summary.length > 0
    ? selectedReport.summary[0]
    : null;

  return (
    <div className="flex h-screen bg-gray-50 font-sans text-gray-900 overflow-hidden">
      {/* Sidebar - History */}
      <div className="w-80 bg-white border-r border-gray-200 flex flex-col shadow-sm z-10">
        <div className="p-6 border-b border-gray-100">
          <div className="flex items-center gap-2 text-indigo-600 mb-1">
            <BarChart3 className="w-6 h-6" />
            <h1 className="font-bold text-lg tracking-tight">FaultAnalyzer</h1>
          </div>
          <p className="text-xs text-gray-500">Fault Detection & Statistics</p>
        </div>

        <div className="p-4 border-b border-gray-100 bg-gray-50/50">
          <label 
            className={`
              flex flex-col items-center justify-center w-full h-32 
              border-2 border-dashed rounded-xl cursor-pointer transition-all
              ${dragActive ? 'border-indigo-500 bg-indigo-50' : 'border-gray-300 hover:border-indigo-400 hover:bg-white'}
            `}
            onDragEnter={handleDrag}
            onDragLeave={handleDrag}
            onDragOver={handleDrag}
            onDrop={handleDrop}
          >
            <div className="flex flex-col items-center justify-center pt-5 pb-6">
              {isUploading ? (
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600"></div>
              ) : (
                <>
                  <Upload className={`w-8 h-8 mb-2 ${dragActive ? 'text-indigo-500' : 'text-gray-400'}`} />
                  <p className="text-sm text-gray-500 font-medium">Click or drag report / archive</p>
                </>
              )}
            </div>
            <input 
              type="file" 
              className="hidden" 
              accept=".xlsx,.xls,.csv,.zip,.tar,.tgz,.tar.gz,.tbz2,.tar.bz2,.txz,.tar.xz"
              onChange={(e) => handleFileUpload(e.target.files)}
              disabled={isUploading}
            />
          </label>
        </div>

        <div className="px-4 py-3 border-b border-gray-100 text-xs bg-white">
          <div className="text-gray-500">Requester IP: {requester?.client_ip || 'Unknown'}</div>
          <div className="text-gray-500 mt-1">User: {requester?.user?.user || 'Unmapped'}</div>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          <button
            onClick={() => void handleAggregateLatest()}
            disabled={isAggregating}
            className={`
              w-full text-left px-4 py-3 rounded-lg border transition-all mb-2
              ${selectedIsAggregate
                ? 'bg-orange-100 border-orange-300 text-orange-800 shadow-sm ring-1 ring-orange-200'
                : 'bg-orange-50 border-orange-200 text-orange-700 hover:bg-orange-100'}
              ${isAggregating ? 'opacity-70 cursor-not-allowed' : ''}
            `}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <BarChart3 className="w-4 h-4" />
                <span className="font-extrabold tracking-wide">汇总</span>
              </div>
              <span className="text-[11px] font-semibold">
                {isAggregating ? '生成中...' : '最新'}
              </span>
            </div>
            <div className="text-[11px] opacity-80 mt-1">
              一键汇总所有上传者的最新报告
            </div>
          </button>

          <div className="px-3 py-2 text-xs font-semibold text-gray-400 uppercase tracking-wider flex items-center gap-2">
            <History className="w-3 h-3" />
            Report History
          </div>
          {requester?.user?.user ? (
            <button
              onClick={() => {
                const nextOnlyMine = !onlyMine;
                setOnlyMine(nextOnlyMine);
                if (nextOnlyMine) {
                  const mineReports = reports.filter(
                    (report) => isAggregateReport(report) || isMyUploadedReport(report),
                  );
                  if (selectedReport && !mineReports.some((r) => r.id === selectedReport.id)) {
                    if (mineReports[0]) {
                      void handleSelectReport(mineReports[0].id);
                    } else {
                      setSelectedReport(null);
                    }
                  }
                } else if (!selectedReport && reports[0]) {
                  void handleSelectReport(reports[0].id);
                }
              }}
              className={`
                w-full text-left px-3 py-2 text-xs rounded-lg border transition-colors
                ${onlyMine
                  ? 'bg-indigo-600 border-indigo-600 text-white'
                  : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'}
              `}
            >
              {onlyMine ? 'Show All Reports' : `Only My Uploaded Reports (${requester.user.user})`}
            </button>
          ) : null}
          {visibleReports.length === 0 ? (
            <div className="text-center py-8 text-gray-400 text-sm">
              {onlyMine ? 'No reports uploaded by you yet.' : 'No reports yet.'}
            </div>
          ) : (
            visibleReports.map(report => {
              const reportIsAggregate = isAggregateReport(report);
              const reportIsSelected = selectedReport?.id === report.id;
              return (
                <button
                  key={report.id}
                  onClick={() => void handleSelectReport(report.id)}
                  className={`
                    w-full text-left px-4 py-3 rounded-lg text-sm transition-all group relative
                    ${reportIsSelected
                      ? reportIsAggregate
                        ? 'bg-orange-100 text-orange-800 font-bold shadow-sm ring-1 ring-orange-300'
                        : 'bg-indigo-50 text-indigo-700 font-medium shadow-sm ring-1 ring-indigo-200'
                      : reportIsAggregate
                        ? 'text-orange-700 bg-orange-50 hover:bg-orange-100 font-bold'
                        : 'text-gray-600 hover:bg-gray-100'}
                  `}
                >
                  <div className="flex items-center gap-3 mb-1">
                    <FileSpreadsheet
                      className={`w-4 h-4 ${
                        reportIsAggregate
                          ? 'text-orange-500'
                          : reportIsSelected
                            ? 'text-indigo-500'
                            : 'text-gray-400'
                      }`}
                    />
                    <span className="truncate flex-1">
                      {reportIsAggregate ? '汇总' : report.filename}
                    </span>
                    {reportIsAggregate ? (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-orange-200 text-orange-800">
                        汇总
                      </span>
                    ) : null}
                  </div>
                  <div className="text-xs opacity-70 pl-7">
                    {new Date(report.created_at).toLocaleString()}
                  </div>
                  <div className="text-xs opacity-60 pl-7">
                    By: {reportIsAggregate ? 'System' : (report.uploader_user || report.uploader_ip || 'Unknown')}
                  </div>

                  <div
                    onClick={(e) => handleDeleteReport(report.id, e)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-md hover:bg-red-100 text-gray-400 hover:text-red-600 opacity-0 group-hover:opacity-100 transition-opacity"
                    title="Delete Report"
                  >
                    <Trash2 className="w-4 h-4" />
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto bg-gray-50/50">
        {isLoadingReport ? (
          <div className="h-full flex items-center justify-center text-gray-500">
            Loading report...
          </div>
        ) : selectedReport ? (
          <div className="max-w-5xl mx-auto p-8">
            <header className="mb-8">
              <div className="flex items-center gap-3 text-sm text-gray-500 mb-2">
                <span>Report ID: #{selectedReport.id}</span>
                <span>•</span>
                <span>{new Date(selectedReport.created_at).toLocaleString()}</span>
                <span>•</span>
                <span>Uploader: {selectedIsAggregate ? 'System' : (selectedReport.uploader_user || selectedReport.uploader_ip || 'Unknown')}</span>
              </div>
              <h2 className={`text-3xl font-bold ${selectedIsAggregate ? 'text-orange-700' : 'text-gray-900'}`}>
                {selectedIsAggregate ? '汇总' : selectedReport.filename}
              </h2>
              {selectedIsAggregate ? (
                <p className="mt-2 text-sm text-orange-600">
                  所有上传者最新报告的报警汇总
                </p>
              ) : null}
            </header>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
              <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
                <div className="text-sm text-gray-500 font-medium mb-1">Total Owners</div>
                <div className="text-3xl font-bold text-gray-900">{selectedReport.summary.length}</div>
              </div>
              <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
                <div className="text-sm text-gray-500 font-medium mb-1">Total Faults Detected</div>
                <div className="text-3xl font-bold text-indigo-600">
                  {totalFaults}
                </div>
              </div>
              <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
                <div className="text-sm text-gray-500 font-medium mb-1">Top Offender</div>
                <div className="text-xl font-bold text-gray-900 truncate">
                  {topOwner ? topOwner.owner : 'N/A'}
                </div>
                <div className="text-xs text-gray-500 mt-1">
                  {topOwner ? `${topOwner.total} faults` : ''}
                </div>
              </div>
            </div>

            <div className="space-y-4">
              <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
                <User className="w-5 h-5 text-gray-500" />
                Detailed Breakdown by Owner
              </h3>
              
              {selectedReport.summary.map((item, index) => {
                const overLimit = item.total > alarmWarningThreshold;
                return (
                <motion.div 
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: index * 0.05 }}
                  key={item.owner} 
                  className={`
                    bg-white rounded-xl shadow-sm border overflow-hidden
                    ${overLimit ? 'border-orange-300 ring-1 ring-orange-200' : 'border-gray-200'}
                  `}
                >
                  <button 
                    onClick={() => toggleOwner(item.owner)}
                    className={`w-full flex items-center justify-between p-4 transition-colors ${overLimit ? 'hover:bg-orange-50' : 'hover:bg-gray-50'}`}
                  >
                    <div className="flex items-center gap-4">
                      <div className={`
                        w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold
                        ${overLimit
                          ? 'bg-orange-100 text-orange-700'
                          : index < 3
                            ? 'bg-indigo-100 text-indigo-700'
                            : 'bg-gray-100 text-gray-600'}
                      `}>
                        {index + 1}
                      </div>
                      <div className="text-left">
                        <div className="font-semibold text-gray-900 flex items-center gap-2">
                          <span>{item.owner}</span>
                          {overLimit ? (
                            <span className="text-[10px] px-2 py-0.5 rounded-full bg-orange-100 text-orange-700 border border-orange-200">
                              OVER {alarmWarningThreshold}
                            </span>
                          ) : null}
                        </div>
                        <div className="text-xs text-gray-500">{item.faults.length} unique fault types</div>
                      </div>
                    </div>
                    
                    <div className="flex items-center gap-6">
                      <div className="text-right">
                        <div className={`text-lg font-bold ${overLimit ? 'text-orange-600' : 'text-gray-900'}`}>{item.total}</div>
                        <div className="text-xs text-gray-500 uppercase tracking-wide">Faults</div>
                      </div>
                      {expandedOwners[item.owner] ? (
                        <ChevronDown className="w-5 h-5 text-gray-400" />
                      ) : (
                        <ChevronRight className="w-5 h-5 text-gray-400" />
                      )}
                    </div>
                  </button>

                  <AnimatePresence>
                    {expandedOwners[item.owner] && (
                      <motion.div 
                        initial={{ height: 0 }}
                        animate={{ height: 'auto' }}
                        exit={{ height: 0 }}
                        className={`overflow-hidden border-t ${overLimit ? 'bg-orange-50/40 border-orange-100' : 'bg-gray-50 border-gray-100'}`}
                      >
                        <div className="p-4">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="text-xs text-gray-400 uppercase tracking-wider text-left">
                                <th className="pb-2 font-medium">Fault Description (desc)</th>
                                <th className="pb-2 font-medium text-right w-24">Count</th>
                                <th className="pb-2 font-medium text-right w-32">Share</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-200/50">
                              {item.faults.map((fault, idx) => {
                                const modelOverLimit = fault.count > alarmWarningThreshold;
                                return (
                                  <tr
                                    key={idx}
                                    className={`transition-colors ${modelOverLimit ? 'bg-orange-50/60 hover:bg-orange-100/60' : 'hover:bg-gray-100/50'}`}
                                  >
                                    <td className={`py-2 flex items-center gap-2 ${modelOverLimit ? 'text-orange-700 font-medium' : 'text-gray-700'}`}>
                                      <AlertCircle className={`w-3 h-3 ${modelOverLimit ? 'text-orange-500' : 'text-orange-400'}`} />
                                      <span>{fault.name}</span>
                                      {modelOverLimit ? (
                                        <span className="ml-1 inline-flex items-center rounded-full bg-orange-100 text-orange-700 px-2 py-0.5 text-[10px] font-semibold tracking-wide">
                                          OVER {alarmWarningThreshold}
                                        </span>
                                      ) : null}
                                    </td>
                                    <td className={`py-2 text-right font-mono font-medium ${modelOverLimit ? 'text-orange-600' : 'text-gray-900'}`}>{fault.count}</td>
                                    <td className="py-2 text-right">
                                      <div className="flex items-center justify-end gap-2">
                                        <span className={`text-xs w-8 ${modelOverLimit ? 'text-orange-600 font-semibold' : 'text-gray-500'}`}>
                                          {Math.round((fault.count / item.total) * 100)}%
                                        </span>
                                        <div className={`w-16 h-1.5 rounded-full overflow-hidden ${modelOverLimit ? 'bg-orange-100' : 'bg-gray-200'}`}>
                                          <div
                                            className={`h-full rounded-full ${modelOverLimit ? 'bg-orange-500' : 'bg-indigo-500'}`}
                                            style={{ width: `${(fault.count / item.total) * 100}%` }}
                                          />
                                        </div>
                                      </div>
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.div>
              );
            })}
            </div>
          </div>
        ) : (
          <div className="h-full flex flex-col items-center justify-center text-gray-400 p-8">
            <div className="w-24 h-24 bg-gray-100 rounded-full flex items-center justify-center mb-6">
              <BarChart3 className="w-10 h-10 text-gray-300" />
            </div>
            <h3 className="text-xl font-semibold text-gray-900 mb-2">No Report Selected</h3>
            <p className="max-w-md text-center text-gray-500">
              Upload a new Excel file using the sidebar, or select an existing report from the history to view the analysis.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
