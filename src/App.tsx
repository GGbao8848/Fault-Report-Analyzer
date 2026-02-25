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
}

export default function App() {
  const [reports, setReports] = useState<Report[]>([]);
  const [selectedReport, setSelectedReport] = useState<Report | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [expandedOwners, setExpandedOwners] = useState<Record<string, boolean>>({});

  useEffect(() => {
    fetchReports();
  }, []);

  const fetchReports = async () => {
    try {
      const res = await fetch('/api/reports');
      if (res.ok) {
        const data = await res.json();
        setReports(data);
        if (data.length > 0 && !selectedReport) {
          setSelectedReport(data[0]);
        }
      }
    } catch (err) {
      console.error('Failed to fetch reports', err);
    }
  };

  const handleFileUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    
    const file = files[0];
    const formData = new FormData();
    formData.append('file', file);

    setIsUploading(true);
    try {
      const res = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
      });

      if (res.ok) {
        const newReport = await res.json();
        setReports(prev => [newReport, ...prev]);
        setSelectedReport(newReport);
      } else {
        alert('Upload failed. Please ensure the file is a valid Excel file.');
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
          setSelectedReport(newReports[0] || null);
        }
      }
    } catch (err) {
      console.error('Delete error', err);
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
                  <p className="text-sm text-gray-500 font-medium">Click or drag .xlsx</p>
                </>
              )}
            </div>
            <input 
              type="file" 
              className="hidden" 
              accept=".xlsx, .xls"
              onChange={(e) => handleFileUpload(e.target.files)}
              disabled={isUploading}
            />
          </label>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          <div className="px-3 py-2 text-xs font-semibold text-gray-400 uppercase tracking-wider flex items-center gap-2">
            <History className="w-3 h-3" />
            Report History
          </div>
          {reports.length === 0 ? (
            <div className="text-center py-8 text-gray-400 text-sm">
              No reports yet.
            </div>
          ) : (
            reports.map(report => (
              <button
                key={report.id}
                onClick={() => setSelectedReport(report)}
                className={`
                  w-full text-left px-4 py-3 rounded-lg text-sm transition-all group relative
                  ${selectedReport?.id === report.id 
                    ? 'bg-indigo-50 text-indigo-700 font-medium shadow-sm ring-1 ring-indigo-200' 
                    : 'text-gray-600 hover:bg-gray-100'}
                `}
              >
                <div className="flex items-center gap-3 mb-1">
                  <FileSpreadsheet className={`w-4 h-4 ${selectedReport?.id === report.id ? 'text-indigo-500' : 'text-gray-400'}`} />
                  <span className="truncate flex-1">{report.filename}</span>
                </div>
                <div className="text-xs opacity-70 pl-7">
                  {new Date(report.created_at).toLocaleString()}
                </div>
                
                <div 
                  onClick={(e) => handleDeleteReport(report.id, e)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-md hover:bg-red-100 text-gray-400 hover:text-red-600 opacity-0 group-hover:opacity-100 transition-opacity"
                  title="Delete Report"
                >
                  <Trash2 className="w-4 h-4" />
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto bg-gray-50/50">
        {selectedReport ? (
          <div className="max-w-5xl mx-auto p-8">
            <header className="mb-8">
              <div className="flex items-center gap-3 text-sm text-gray-500 mb-2">
                <span>Report ID: #{selectedReport.id}</span>
                <span>•</span>
                <span>{new Date(selectedReport.created_at).toLocaleString()}</span>
              </div>
              <h2 className="text-3xl font-bold text-gray-900">{selectedReport.filename}</h2>
            </header>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
              <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
                <div className="text-sm text-gray-500 font-medium mb-1">Total Owners</div>
                <div className="text-3xl font-bold text-gray-900">{selectedReport.summary.length}</div>
              </div>
              <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
                <div className="text-sm text-gray-500 font-medium mb-1">Total Faults Detected</div>
                <div className="text-3xl font-bold text-indigo-600">
                  {selectedReport.summary.reduce((acc, curr) => acc + curr.total, 0)}
                </div>
              </div>
              <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
                <div className="text-sm text-gray-500 font-medium mb-1">Top Offender</div>
                <div className="text-xl font-bold text-gray-900 truncate">
                  {selectedReport.summary.length > 0 ? selectedReport.summary[0].owner : 'N/A'}
                </div>
                <div className="text-xs text-gray-500 mt-1">
                  {selectedReport.summary.length > 0 ? `${selectedReport.summary[0].total} faults` : ''}
                </div>
              </div>
            </div>

            <div className="space-y-4">
              <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
                <User className="w-5 h-5 text-gray-500" />
                Detailed Breakdown by Owner
              </h3>
              
              {selectedReport.summary.map((item, index) => (
                <motion.div 
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: index * 0.05 }}
                  key={item.owner} 
                  className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden"
                >
                  <button 
                    onClick={() => toggleOwner(item.owner)}
                    className="w-full flex items-center justify-between p-4 hover:bg-gray-50 transition-colors"
                  >
                    <div className="flex items-center gap-4">
                      <div className={`
                        w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold
                        ${index < 3 ? 'bg-indigo-100 text-indigo-700' : 'bg-gray-100 text-gray-600'}
                      `}>
                        {index + 1}
                      </div>
                      <div className="text-left">
                        <div className="font-semibold text-gray-900">{item.owner}</div>
                        <div className="text-xs text-gray-500">{item.faults.length} unique fault types</div>
                      </div>
                    </div>
                    
                    <div className="flex items-center gap-6">
                      <div className="text-right">
                        <div className="text-lg font-bold text-gray-900">{item.total}</div>
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
                        className="overflow-hidden bg-gray-50 border-t border-gray-100"
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
                              {item.faults.map((fault, idx) => (
                                <tr key={idx} className="hover:bg-gray-100/50">
                                  <td className="py-2 text-gray-700 flex items-center gap-2">
                                    <AlertCircle className="w-3 h-3 text-orange-400" />
                                    {fault.name}
                                  </td>
                                  <td className="py-2 text-right font-mono font-medium text-gray-900">{fault.count}</td>
                                  <td className="py-2 text-right">
                                    <div className="flex items-center justify-end gap-2">
                                      <span className="text-xs text-gray-500 w-8">
                                        {Math.round((fault.count / item.total) * 100)}%
                                      </span>
                                      <div className="w-16 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                                        <div 
                                          className="h-full bg-indigo-500 rounded-full" 
                                          style={{ width: `${(fault.count / item.total) * 100}%` }}
                                        />
                                      </div>
                                    </div>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.div>
              ))}
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
